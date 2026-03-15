import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'

function summarizeNotificationData(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null

  const record = data as Record<string, unknown>
  const fields: string[] = []

  const commentId = typeof record.commentId === 'string' ? record.commentId : null
  const videoId = typeof record.videoId === 'string' ? record.videoId : null
  const videoName = typeof record.videoName === 'string' ? record.videoName : null
  const authorName = typeof record.authorName === 'string' ? record.authorName : null
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null
  const isReply = typeof record.isReply === 'boolean' ? record.isReply : null
  const content = typeof record.content === 'string' ? record.content.trim() : null

  if (videoName) fields.push(`video=${videoName}`)
  if (authorName) fields.push(`author=${authorName}`)
  if (timestamp) fields.push(`timestamp=${timestamp}`)
  if (isReply === true) fields.push('reply=yes')
  if (commentId) fields.push(`commentId=${commentId}`)
  if (videoId) fields.push(`videoId=${videoId}`)

  if (content) {
    const collapsed = content.replace(/\s+/g, ' ').trim()
    fields.push(`content=${collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed}`)
  }

  return fields.length ? fields.join(' | ') : null
}

function serializeBacklogEntry(entry: {
  id: string
  createdAt: Date
  projectId: string | null
  type: string
  clientAttempts: number
  adminAttempts: number
  clientFailed: boolean
  adminFailed: boolean
  lastError: string | null
  data: unknown
  sentToClients: boolean
  sentToAdmins: boolean
  project: { title: string } | null
}) {
  return {
    id: entry.id,
    createdAt: entry.createdAt.toISOString(),
    projectId: entry.projectId,
    projectTitle: entry.project?.title || null,
    type: entry.type,
    pendingTargets: [
      !entry.sentToClients && !entry.clientFailed ? 'clients' : null,
      !entry.sentToAdmins && !entry.adminFailed ? 'admins' : null,
    ].filter((value): value is string => Boolean(value)),
    attempts: {
      clients: entry.clientAttempts,
      admins: entry.adminAttempts,
    },
    failed: {
      clients: entry.clientFailed,
      admins: entry.adminFailed,
    },
    lastError: entry.lastError || null,
    summary: summarizeNotificationData(entry.data),
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 10 })
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => ({}))
  const dryRun = body.dryRun !== false

  try {
    // Find all rows where either side has never been sent
    const pending = await prisma.notificationQueue.findMany({
      where: {
        OR: [
          { sentToClients: false, clientFailed: false },
          { sentToAdmins: false, adminFailed: false },
        ],
      },
      select: {
        id: true,
        createdAt: true,
        projectId: true,
        type: true,
        clientAttempts: true,
        adminAttempts: true,
        clientFailed: true,
        adminFailed: true,
        lastError: true,
        data: true,
        sentToClients: true,
        sentToAdmins: true,
        project: {
          select: {
            title: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const stale = pending.filter(r => r.createdAt < sevenDaysAgo)
    const recent = pending.filter(r => r.createdAt >= sevenDaysAgo)
    const staleSample = stale.slice(0, 50).map(serializeBacklogEntry)
    const staleSampleTruncated = stale.length > staleSample.length

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        totalUnsent: pending.length,
        staleCount: stale.length,
        recentCount: recent.length,
        oldestCreatedAt: pending[0]?.createdAt ?? null,
        staleSample,
        staleSampleTruncated,
      })
    }

    // Mark all unsent stale rows as dismissed on both sides
    const now = new Date()
    const result = await prisma.notificationQueue.updateMany({
      where: {
        id: { in: stale.map(r => r.id) },
      },
      data: {
        sentToClients: true,
        sentToAdmins: true,
        clientSentAt: now,
        adminSentAt: now,
      },
    })

    return NextResponse.json({
      ok: true,
      dryRun: false,
      dismissed: result.count,
      recentCount: recent.length,
      oldestCreatedAt: pending[0]?.createdAt ?? null,
      staleSample,
      staleSampleTruncated,
    })
  } catch (err: any) {
    console.error('[purge-notification-backlog]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
