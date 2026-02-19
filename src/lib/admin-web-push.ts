import * as webpush from 'web-push'
import { prisma } from '@/lib/db'
import { decrypt, encrypt } from '@/lib/encryption'
import type { PushNotificationPayload } from '@/lib/push-notifications'
import { buildAdminWebPushNotification } from '@/lib/admin-web-push-templates'
import { canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'

type VapidKeys = { publicKey: string; privateKey: string }

let cachedVapid: VapidKeys | null = null
let cachedConfigured = false

function getVapidSubject(appDomain?: string | null): string {
  const fromEnv = typeof process.env.WEB_PUSH_VAPID_SUBJECT === 'string' ? process.env.WEB_PUSH_VAPID_SUBJECT.trim() : ''
  if (fromEnv) return fromEnv

  const domain = typeof appDomain === 'string' ? appDomain.trim() : ''
  if (domain) return domain

  return 'mailto:no-reply@vitransfer.local'
}

async function getOrCreateVapidKeys(): Promise<{ keys: VapidKeys; subject: string }> {
  const settings = await prisma.settings.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default' },
    select: {
      appDomain: true,
      webPushVapidPublicKey: true,
      webPushVapidPrivateKeyEncrypted: true,
    },
  })

  const subject = getVapidSubject(settings.appDomain)

  if (settings.webPushVapidPublicKey && settings.webPushVapidPrivateKeyEncrypted) {
    return {
      keys: {
        publicKey: settings.webPushVapidPublicKey,
        privateKey: decrypt(settings.webPushVapidPrivateKeyEncrypted),
      },
      subject,
    }
  }

  const generated = webpush.generateVAPIDKeys()

  await prisma.settings.update({
    where: { id: 'default' },
    data: {
      webPushVapidPublicKey: generated.publicKey,
      webPushVapidPrivateKeyEncrypted: encrypt(generated.privateKey),
    },
  })

  return {
    keys: { publicKey: generated.publicKey, privateKey: generated.privateKey },
    subject,
  }
}

async function ensureConfigured(): Promise<VapidKeys> {
  if (cachedConfigured && cachedVapid) return cachedVapid

  const { keys, subject } = await getOrCreateVapidKeys()
  cachedVapid = keys

  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey)
  cachedConfigured = true

  return keys
}

export async function getWebPushPublicKey(): Promise<string> {
  const { keys } = await getOrCreateVapidKeys()
  return keys.publicKey
}

export async function upsertWebPushSubscription(params: {
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  deviceName?: string | null
  userAgent?: string | null
}): Promise<{ id: string; endpoint: string; deviceName: string | null; createdAt: Date } | null> {
  const endpoint = params.endpoint.trim()
  if (!endpoint) return null

  const existing = await prisma.webPushSubscription.findUnique({
    where: { endpoint },
    select: { id: true, userId: true },
  })

  if (existing && existing.userId !== params.userId) {
    throw new Error('This browser subscription is already registered to another user.')
  }

  const sub = await prisma.webPushSubscription.upsert({
    where: { endpoint },
    update: {
      userId: params.userId,
      p256dh: params.p256dh,
      auth: params.auth,
      deviceName: params.deviceName ?? null,
      userAgent: params.userAgent ?? null,
    },
    create: {
      userId: params.userId,
      endpoint,
      p256dh: params.p256dh,
      auth: params.auth,
      deviceName: params.deviceName ?? null,
      userAgent: params.userAgent ?? null,
    },
    select: { id: true, endpoint: true, deviceName: true, createdAt: true },
  })

  return sub
}

export async function deleteWebPushSubscription(params: { userId: string; endpoint?: string; id?: string }): Promise<number> {
  if (params.id) {
    const deleted = await prisma.webPushSubscription.deleteMany({
      where: { id: params.id, userId: params.userId },
    })
    return deleted.count
  }

  if (params.endpoint) {
    const deleted = await prisma.webPushSubscription.deleteMany({
      where: { endpoint: params.endpoint, userId: params.userId },
    })
    return deleted.count
  }

  return 0
}

export async function listWebPushSubscriptionsForUser(userId: string) {
  const subs = await prisma.webPushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, endpoint: true, deviceName: true, createdAt: true, updatedAt: true, userAgent: true },
  })

  return subs.map((s) => {
    let endpointOrigin = s.endpoint
    try {
      endpointOrigin = new URL(s.endpoint).origin
    } catch {
      // ignore
    }

    return {
      ...s,
      endpointOrigin,
    }
  })
}

async function sendToSubscription(sub: { endpoint: string; p256dh: string; auth: string }, notification: { title: string; body: string; url: string }) {
  await ensureConfigured()

  const webPushSub = {
    endpoint: sub.endpoint,
    keys: {
      p256dh: sub.p256dh,
      auth: sub.auth,
    },
  }

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url,
  })

  await webpush.sendNotification(webPushSub as any, payload)
}

// Notification types scoped to project events (non-security)
const PROJECT_PUSH_TYPES = ['CLIENT_COMMENT', 'ADMIN_SHARE_COMMENT', 'VIDEO_APPROVAL', 'INTERNAL_COMMENT']
const SALES_PUSH_TYPES = ['SALES_QUOTE_VIEWED', 'SALES_QUOTE_ACCEPTED', 'SALES_INVOICE_VIEWED', 'SALES_INVOICE_PAID']

/**
 * Send a browser push notification to all eligible subscribers.
 *
 * Scoping rules:
 *   - Security events  → system admins only
 *   - Project events   → system admins + users with 'projects' menu access assigned to the project
 *   - Sales events     → system admins + users with 'sales' menu access
 *
 * The comment/event author (via __meta.authorUserId) is always excluded.
 */
export async function sendBrowserPushToEligibleUsers(payload: PushNotificationPayload): Promise<void> {
  const notification = buildAdminWebPushNotification(payload)

  const authorUserId = (payload.details && typeof (payload.details as any)?.__meta?.authorUserId === 'string')
    ? String((payload.details as any).__meta.authorUserId)
    : null

  const projectId = payload.projectId ?? null
  const isProjectType = PROJECT_PUSH_TYPES.includes(payload.type)
  const isSalesType = SALES_PUSH_TYPES.includes(payload.type)

  // For project-scoped events, pre-fetch the assigned user IDs so we avoid
  // sending to users who don't have access to that specific project.
  let assignedProjectUserIds: Set<string> | null = null
  if (isProjectType && projectId) {
    const rows = await prisma.projectUser.findMany({
      where: { projectId },
      select: { userId: true },
    })
    assignedProjectUserIds = new Set(rows.map((r) => r.userId))
  }

  const subs = await prisma.webPushSubscription.findMany({
    select: {
      id: true,
      userId: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      user: {
        select: {
          appRole: { select: { permissions: true, name: true, isSystemAdmin: true } },
        },
      },
    },
  })

  const filteredSubs = subs.filter((s) => {
    // Never notify the author of the event.
    if (authorUserId && s.userId === authorUserId) return false

    const role = (s as any).user?.appRole
    const isSystemAdmin = role?.isSystemAdmin === true

    // System admins receive all notification types.
    if (isSystemAdmin) return true

    // Non-system-admin: check menu-level entitlements.
    const permissions = normalizeRolePermissions(role?.permissions)

    if (isProjectType) {
      if (!canSeeMenu(permissions, 'projects')) return false
      // Must also be assigned to the specific project (if we know it).
      if (assignedProjectUserIds !== null && !assignedProjectUserIds.has(s.userId)) return false
      return true
    }

    if (isSalesType) {
      return canSeeMenu(permissions, 'sales')
    }

    // Security / other events: non-system-admins do not receive these.
    return false
  })

  if (filteredSubs.length === 0) return

  await ensureConfigured()

  await Promise.all(
    filteredSubs.map(async (s) => {
      try {
        await sendToSubscription(s, notification)
      } catch (err: any) {
        // If the endpoint is gone, clean it up.
        const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : null
        if (statusCode === 404 || statusCode === 410) {
          await prisma.webPushSubscription.deleteMany({ where: { id: s.id } })
        }
        console.warn('[WEB_PUSH] Failed to send notification:', statusCode ?? '', err?.message ?? err)
      }
    })
  )
}

export async function sendTestBrowserPushToUser(params: { userId: string; endpoint?: string; id?: string }) {
  const sub = params.id
    ? await prisma.webPushSubscription.findFirst({ where: { id: params.id, userId: params.userId } })
    : params.endpoint
      ? await prisma.webPushSubscription.findFirst({ where: { endpoint: params.endpoint, userId: params.userId } })
      : null

  if (!sub) {
    return { ok: false as const, error: 'Subscription not found' }
  }

  try {
    await sendToSubscription(sub, { title: 'ViTransfer', body: 'Test browser push notification', url: '/admin/settings' })
    return { ok: true as const }
  } catch (err: any) {
    const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : null
    if (statusCode === 404 || statusCode === 410) {
      await prisma.webPushSubscription.deleteMany({ where: { id: sub.id } })
    }
    return { ok: false as const, error: err?.message ?? 'Failed to send test notification' }
  }
}
