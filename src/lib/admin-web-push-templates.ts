import type { PushNotificationPayload } from './push-notifications'

export type AdminWebPushNotification = {
  title: string
  body: string
  url: string
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s : null
}

function getDetail(details: Record<string, any> | undefined, keys: string[]): string | null {
  if (!details) return null
  for (const key of keys) {
    const v = details[key]
    if (v === undefined || v === null) continue
    const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
    if (s && s.trim()) return s.trim()
  }
  return null
}

function excerpt(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLen) return compact
  return compact.slice(0, Math.max(0, maxLen - 3)).trimEnd() + '...'
}

function buildUrl(payload: PushNotificationPayload): string {
  const link = payload.details && typeof (payload.details as any).__link?.href === 'string' ? String((payload.details as any).__link.href) : ''
  if (link.startsWith('/admin')) return link

  // Prefer the project page when available.
  if (payload.projectId) return `/admin/projects/${encodeURIComponent(payload.projectId)}`

  // Security-ish events are most useful on the security page.
  if (
    payload.type === 'FAILED_LOGIN' ||
    payload.type === 'SUCCESSFUL_ADMIN_LOGIN' ||
    payload.type === 'FAILED_SHARE_PASSWORD' ||
    payload.type === 'UNAUTHORIZED_OTP' ||
    payload.type === 'PASSWORD_RESET_REQUESTED' ||
    payload.type === 'PASSWORD_RESET_SUCCESS'
  ) {
    return '/admin/security'
  }

  return '/admin'
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' | ')
}

export function buildAdminWebPushNotification(payload: PushNotificationPayload): AdminWebPushNotification {
  const projectTitle = asNonEmptyString(payload.projectName) || getDetail(payload.details, ['Project', 'projectTitle', 'projectName'])
  const url = buildUrl(payload)

  // Common details we may have.
  const ip = getDetail(payload.details, ['IP Address', 'IP'])

  switch (payload.type) {
    case 'CLIENT_COMMENT': {
      const video = getDetail(payload.details, ['Video', 'videoName'])
      const author = getDetail(payload.details, ['Author', 'authorName'])
      const timecode = getDetail(payload.details, ['Timecode', 'timecode'])
      const comment = getDetail(payload.details, ['Comment', 'comment'])

      const title = 'New client comment'
      const body = joinParts([
        projectTitle ? `Project: ${projectTitle}` : null,
        video ? `Video: ${video}` : null,
        author ? `By: ${author}` : null,
        timecode ? `At: ${timecode}` : null,
        comment ? `"${excerpt(comment, 140)}"` : null,
      ])

      return { title, body: body || payload.message, url }
    }

    case 'VIDEO_APPROVAL': {
      const videos = getDetail(payload.details, ['Video(s)', 'Video', 'videoName'])
      const author = getDetail(payload.details, ['Author', 'authorName'])
      const status = getDetail(payload.details, ['Status', 'status'])

      const title = payload.title && payload.title !== 'Video Approved' && payload.title !== 'Video Unapproved'
        ? payload.title
        : 'Video approval updated'

      const body = joinParts([
        projectTitle ? `Project: ${projectTitle}` : null,
        videos ? `Video: ${videos}` : null,
        author ? `By: ${author}` : null,
        status ? status : null,
      ])

      return { title, body: body || payload.message, url }
    }

    case 'SHARE_ACCESS': {
      const method = getDetail(payload.details, ['Access Method', 'accessMethod'])
      const title = 'Share page viewed'
      const body = joinParts([
        projectTitle ? `Project: ${projectTitle}` : null,
        method ? `Via: ${method}` : null,
        ip ? `IP: ${ip}` : null,
      ])
      return { title, body: body || payload.message, url }
    }

    case 'GUEST_VIDEO_LINK_ACCESS': {
      const video = getDetail(payload.details, ['Video', 'videoName'])
      const title = 'Guest link opened'
      const body = joinParts([
        projectTitle ? `Project: ${projectTitle}` : null,
        video ? `Video: ${video}` : null,
        ip ? `IP: ${ip}` : null,
      ])
      return { title, body: body || payload.message, url }
    }

    case 'FAILED_LOGIN': {
      const email = getDetail(payload.details, ['Email/Username', 'Email', 'email'])
      const title = 'Admin login failed'
      const body = joinParts([
        email ? `User: ${email}` : null,
        ip ? `IP: ${ip}` : null,
      ])
      return { title, body: body || payload.message, url: '/admin/security' }
    }

    case 'SUCCESSFUL_ADMIN_LOGIN': {
      const email = getDetail(payload.details, ['Email', 'email'])
      const role = getDetail(payload.details, ['Role', 'role'])
      const title = 'Admin login'
      const body = joinParts([
        role ? `Role: ${role}` : null,
        email ? `User: ${email}` : null,
        ip ? `IP: ${ip}` : null,
      ])
      return { title, body: body || payload.message, url: '/admin/security' }
    }

    case 'FAILED_SHARE_PASSWORD': {
      const attempt = getDetail(payload.details, ['Attempt'])
      const maxAttempts = getDetail(payload.details, ['Max Attempts'])
      const title = 'Share password failed'
      const body = joinParts([
        projectTitle ? `Project: ${projectTitle}` : null,
        attempt ? `Attempt: ${attempt}${maxAttempts ? `/${maxAttempts}` : ''}` : null,
        ip ? `IP: ${ip}` : null,
      ])
      return { title, body: body || payload.message, url: '/admin/security' }
    }

    case 'UNAUTHORIZED_OTP': {
      const attempted = getDetail(payload.details, ['Email Attempted', 'Email'])
      const title = 'Unauthorized OTP request'
      const body = joinParts([
        projectTitle ? `Project: ${projectTitle}` : null,
        attempted ? `Email: ${attempted}` : null,
        ip ? `IP: ${ip}` : null,
      ])
      return { title, body: body || payload.message, url: '/admin/security' }
    }

    case 'PASSWORD_RESET_REQUESTED': {
      const email = getDetail(payload.details, ['Email'])
      const title = 'Password reset requested'
      const body = joinParts([
        email ? `Email: ${email}` : null,
        ip ? `IP: ${ip}` : null,
      ])
      return { title, body: body || payload.message, url: '/admin/security' }
    }

    case 'PASSWORD_RESET_SUCCESS': {
      const email = getDetail(payload.details, ['Email'])
      const title = 'Password changed'
      const body = joinParts([
        email ? `Email: ${email}` : null,
        ip ? `IP: ${ip}` : null,
      ])
      return { title, body: body || payload.message, url: '/admin/security' }
    }

    case 'SALES_QUOTE_VIEWED':
    case 'SALES_QUOTE_ACCEPTED':
    case 'SALES_INVOICE_VIEWED':
    case 'SALES_INVOICE_PAID': {
      const number = getDetail(payload.details, ['Number', 'Invoice', 'quoteNumber'])
      const client = getDetail(payload.details, ['Client', 'clientName'])

      const titleMap: Record<string, string> = {
        SALES_QUOTE_VIEWED: 'Quote viewed',
        SALES_QUOTE_ACCEPTED: 'Quote accepted',
        SALES_INVOICE_VIEWED: 'Invoice viewed',
        SALES_INVOICE_PAID: 'Invoice paid',
      }

      const title = titleMap[payload.type] || payload.title
      const body = joinParts([
        number ? `Number: ${number}` : null,
        client ? `Client: ${client}` : null,
        projectTitle ? `Project: ${projectTitle}` : null,
      ])

      return { title, body: body || payload.message, url }
    }

    default: {
      // Fallback to the caller-provided copy.
      const title = asNonEmptyString(payload.title) || 'ViTransfer'
      const body = asNonEmptyString(payload.message) || 'You have a new notification.'
      return { title, body, url }
    }
  }
}
