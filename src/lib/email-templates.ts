/**
 * Ultra-Compact Email Templates for Notification System
 * Clean, minimal, and easy to scan
 */

import { EMAIL_THEME, emailCardStyle, emailCardTitleStyle, emailPrimaryButtonStyle, emailVersionPillHtml, escapeHtml, firstWordName, renderEmailShell, renderEmailFooterNotice } from './email'
import { formatTimecodeDisplay } from './timecode'

interface NotificationData {
  type: 'CLIENT_COMMENT' | 'ADMIN_REPLY' | 'VIDEO_APPROVED' | 'VIDEO_UNAPPROVED' | 'PROJECT_APPROVED'
  videoName: string
  videoLabel?: string
  authorName: string
  authorEmail?: string
  content?: string
  timecode?: string | null
  isReply?: boolean
  approved?: boolean
  approvedVideos?: Array<{ id: string; name: string }>
  parentComment?: {
    authorName: string
    content: string
  }
  createdAt: string
}

interface NotificationSummaryData {
  companyName: string
  projectTitle: string
  useFullTimecode: boolean
  shareUrl: string
  unsubscribeUrl?: string
  recipientName: string
  recipientEmail: string
  period: string
  notifications: NotificationData[]
  trackingToken?: string
  trackingPixelsEnabled?: boolean
  appDomain?: string
  mainCompanyDomain?: string | null
  companyLogoUrl?: string
  emailCustomFooterText?: string | null
  accentColor?: string
  accentTextMode?: string
  emailHeaderColor?: string
  emailHeaderTextMode?: string
}

interface AdminSummaryData {
  companyName: string
  adminName: string
  period: string
  companyLogoUrl?: string
  mainCompanyDomain?: string | null
  accentColor?: string
  accentTextMode?: string
  emailHeaderColor?: string
  emailHeaderTextMode?: string
  projects: Array<{
    projectTitle: string
    useFullTimecode: boolean
    shareUrl: string
    notifications: NotificationData[]
  }>
}

function formatTimecodeForEmail(timecode: string | null | undefined, useFullTimecode: boolean): string {
  if (!timecode) return ''

  if (useFullTimecode) {
    return formatTimecodeDisplay(timecode)
  }

  // Force M:SS (total minutes) display, even for > 1 hour timestamps.
  return formatTimecodeDisplay(timecode, { showFrames: false, durationSeconds: 0 })
}

/**
 * Client notification summary
 */
export function generateNotificationSummaryEmail(data: NotificationSummaryData): string {
  const rawGreeting = data.recipientName !== data.recipientEmail
    ? data.recipientName
    : 'there'
  const greeting = firstWordName(rawGreeting) || rawGreeting

  // Count notification types
  const commentCount = data.notifications.filter(n => n.type === 'CLIENT_COMMENT' || n.type === 'ADMIN_REPLY').length
  const approvedCount = data.notifications.filter(n => n.type === 'VIDEO_APPROVED' || n.type === 'PROJECT_APPROVED').length
  const unapprovedCount = data.notifications.filter(n => n.type === 'VIDEO_UNAPPROVED').length

  const summaryParts = []
  if (commentCount > 0) summaryParts.push(`${commentCount} new ${commentCount === 1 ? 'comment' : 'comments'}`)
  if (approvedCount > 0) summaryParts.push(`${approvedCount} ${approvedCount === 1 ? 'approval' : 'approvals'}`)
  if (unapprovedCount > 0) summaryParts.push(`${unapprovedCount} unapproved`)
  const summaryText = summaryParts.join(', ') || 'Latest activity'

  const itemsHtmlContent = data.notifications.map((n) => {
    if (n.type === 'PROJECT_APPROVED') {
      return `
        <div style="padding:10px 0;">
          <div style="font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#15803d; margin-bottom:4px;">Project approved</div>
          <div style="font-size:14px; color:#111827;">All videos are ready for download.</div>
        </div>
      `
    }

    if (n.type === 'VIDEO_APPROVED' || n.type === 'VIDEO_UNAPPROVED') {
      const approved = n.type === 'VIDEO_APPROVED'
      return `
        <div style="padding:10px 0;">
          <div style="font-size:14px; font-weight:700; color:#111827; margin-bottom:2px;">${escapeHtml(n.videoName)}${n.videoLabel ? ` ${emailVersionPillHtml(n.videoLabel, data.accentColor, data.accentTextMode)}` : ''}</div>
          <div style="font-size:13px; color:${approved ? '#15803d' : '#b45309'};">${approved ? 'Approved' : 'Approval removed'}</div>
        </div>
      `
    }

    const isReply = n.isReply && n.parentComment
    return `
      <div style="padding:10px 0;">
        <div style="font-size:13px; color:#6b7280; margin-bottom:4px;">
          ${escapeHtml(n.videoName)}${n.videoLabel ? ` ${emailVersionPillHtml(n.videoLabel, data.accentColor, data.accentTextMode)}` : ''}${n.timecode ? ` • ${formatTimecodeForEmail(n.timecode, data.useFullTimecode)}` : ''}
        </div>
        <div style="font-size:14px; font-weight:700; color:#111827; margin-bottom:2px;">${escapeHtml(n.authorName)}</div>
        ${isReply ? `<div style="font-size:12px; color:#6b7280; margin-bottom:6px;">Replying to ${escapeHtml(n.parentComment!.authorName)} — "${escapeHtml(n.parentComment!.content.substring(0, 60))}${n.parentComment!.content.length > 60 ? '...' : ''}"</div>` : ''}
        <div style="font-size:14px; color:#374151; line-height:1.6; white-space:pre-wrap;">${escapeHtml(n.content || '')}</div>
      </div>
    `
  }).join('<div style="height:1px; background:#e5e7eb; margin:6px 0;"></div>')

  const itemsHtml = `
    <div style="${emailCardStyle({ paddingPx: 10, borderRadiusPx: 12, marginBottomPx: 14 })}">
      ${itemsHtmlContent}
    </div>
  `

  return renderEmailShell({
    companyName: data.companyName,
    companyLogoUrl: data.companyLogoUrl,
    headerGradient: data.emailHeaderColor || EMAIL_THEME.headerBackground,
    headerTextColor: (data.emailHeaderTextMode || 'LIGHT') === 'DARK' ? '#111827' : '#ffffff',
    title: 'Project Update',
    subtitle: `${summaryText} ${data.period}`,
    trackingToken: data.trackingToken,
    trackingPixelsEnabled: data.trackingPixelsEnabled,
    appDomain: data.appDomain,
    mainCompanyDomain: data.mainCompanyDomain,
    footerNote: data.companyName,
    bodyContent: `
      <p style="margin:0 0 20px; font-size:16px;">
        Hi <strong>${escapeHtml(greeting)}</strong>,
      </p>
      <p style="margin:0 0 24px; font-size:15px;">
        Here's what happened on your project:
      </p>
      ${itemsHtml}
      <div style="text-align:center; margin:32px 0;">
        <a href="${escapeHtml(data.shareUrl)}" style="${emailPrimaryButtonStyle({ fontSizePx: 16, borderRadiusPx: 8, accent: data.accentColor, accentTextMode: data.accentTextMode })}">
          View Project
        </a>
      </div>
      ${data.unsubscribeUrl ? `
        <p style="margin:24px 0 0; font-size:13px; color:#9ca3af; text-align:center; line-height:1.5;">
          Don't want to receive updates for this project? <a href="${escapeHtml(data.unsubscribeUrl)}" style="text-decoration:underline;">Unsubscribe</a>
        </p>
      ` : ''}
      ${renderEmailFooterNotice(data.emailCustomFooterText)}
    `,
  }).trim()
}

/**
 * Admin summary - multi-project
 */
export function generateAdminSummaryEmail(data: AdminSummaryData): string {
  const rawGreeting = data.adminName ? data.adminName : 'there'
  const greeting = firstWordName(rawGreeting) || rawGreeting
  const totalComments = data.projects.reduce((sum, p) => sum + p.notifications.length, 0)
  const projectCount = data.projects.length

  const projectsHtml = data.projects.map((project) => {
    const items = project.notifications.map((n, index) => `
      <div style="padding:10px 0;${index > 0 ? ' border-top:1px solid #e5e7eb; margin-top:8px;' : ''}">
        <div style="font-size:13px; color:#6b7280; margin-bottom:4px;">
          ${escapeHtml(n.videoName)}${n.videoLabel ? ` ${emailVersionPillHtml(n.videoLabel, data.accentColor, data.accentTextMode)}` : ''}${n.timecode ? ` • ${formatTimecodeForEmail(n.timecode, project.useFullTimecode)}` : ''}
        </div>
        <div style="margin-bottom:4px;">
          <span style="font-size:14px; font-weight:700; color:#111827;">${escapeHtml(n.authorName)}</span>
          ${n.authorEmail ? `<span style="font-size:12px; color:#6b7280; margin-left:6px;">${escapeHtml(n.authorEmail)}</span>` : ''}
        </div>
        <div style="font-size:14px; color:#374151; line-height:1.6; white-space:pre-wrap;">${escapeHtml(n.content || '')}</div>
      </div>
    `).join('')

    return `
      <div style="${emailCardStyle({ paddingPx: 16, borderRadiusPx: 12, marginBottomPx: 16 })}">
        <div style="font-size:15px; font-weight:800; color:#111827; margin-bottom:8px;">${escapeHtml(project.projectTitle)}</div>
        ${items}
        <div style="margin-top:12px; text-align:center;">
          <a href="${escapeHtml(project.shareUrl)}" style="${emailPrimaryButtonStyle({ fontSizePx: 14, padding: '10px 22px', borderRadiusPx: 999, accent: data.accentColor, accentTextMode: data.accentTextMode })}">
            View project<span style="font-size:16px;">→</span>
          </a>
        </div>
      </div>
    `
  }).join('')

  const adminUrl = data.projects[0]?.shareUrl ? escapeHtml(data.projects[0].shareUrl.replace(/\/share\/[^/]+/, '/admin/projects')) : '#'

  return renderEmailShell({
    companyName: data.companyName,
    companyLogoUrl: data.companyLogoUrl,
    headerGradient: data.emailHeaderColor || EMAIL_THEME.headerBackground,
    headerTextColor: (data.emailHeaderTextMode || 'LIGHT') === 'DARK' ? '#111827' : '#ffffff',
    title: 'Client Activity Summary',
    subtitle: `${totalComments} ${totalComments === 1 ? 'comment' : 'comments'} across ${projectCount} ${projectCount === 1 ? 'project' : 'projects'} ${data.period}`,
    mainCompanyDomain: data.mainCompanyDomain,
    footerNote: data.companyName,
    bodyContent: `
      <p style="margin:0 0 20px; font-size:16px;">
        Hi <strong>${escapeHtml(greeting)}</strong>,
      </p>
      <p style="margin:0 0 24px; font-size:15px;">
        Here are the latest client comments:
      </p>
      ${projectsHtml}
      <div style="text-align:center; margin:32px 0;">
        <a href="${adminUrl}" style="${emailPrimaryButtonStyle({ fontSizePx: 16, borderRadiusPx: 8, accent: data.accentColor, accentTextMode: data.accentTextMode })}">
          Open Admin Dashboard
        </a>
      </div>
    `,
  }).trim()
}

export interface InternalCommentSummaryProject {
  projectTitle: string
  adminUrl: string
  comments: Array<{ authorName: string; authorEmail?: string | null; content: string }>
}

export interface InternalCommentSummaryEmailData {
  companyName: string
  recipientName?: string
  period: string
  companyLogoUrl?: string
  mainCompanyDomain?: string | null
  accentColor?: string
  accentTextMode?: string
  emailHeaderColor?: string
  emailHeaderTextMode?: string
  projects: InternalCommentSummaryProject[]
}

export function generateInternalCommentSummaryEmail(data: InternalCommentSummaryEmailData): string {
  const rawGreeting = data.recipientName ? data.recipientName : 'there'
  const greeting = firstWordName(rawGreeting) || rawGreeting
  const total = data.projects.reduce((sum, p) => sum + p.comments.length, 0)
  const projectCount = data.projects.length

  const projectsHtml = data.projects.map((project) => {
    const items = project.comments.map((c, index) => `
      <div style="padding:10px 0;${index > 0 ? ' border-top:1px solid #e5e7eb; margin-top:8px;' : ''}">
        <div style="margin-bottom:4px;">
          <span style="font-size:14px; font-weight:700; color:#111827;">${escapeHtml(c.authorName)}</span>
          ${c.authorEmail ? `<span style="font-size:12px; color:#6b7280; margin-left:6px;">${escapeHtml(c.authorEmail)}</span>` : ''}
        </div>
        <div style="font-size:14px; color:#374151; line-height:1.6; white-space:pre-wrap;">${escapeHtml(c.content || '')}</div>
      </div>
    `).join('')

    return `
      <div style="${emailCardStyle({ paddingPx: 16, borderRadiusPx: 12, marginBottomPx: 16 })}">
        <div style="font-size:15px; font-weight:800; color:#111827; margin-bottom:8px;">${escapeHtml(project.projectTitle)}</div>
        ${items}
        <div style="margin-top:12px; text-align:center;">
          <a href="${escapeHtml(project.adminUrl)}" style="${emailPrimaryButtonStyle({ fontSizePx: 14, padding: '10px 22px', borderRadiusPx: 999, accent: data.accentColor, accentTextMode: data.accentTextMode })}">
            Open project<span style="font-size:16px;">→</span>
          </a>
        </div>
      </div>
    `
  }).join('')

  const dashboardUrl = data.projects[0]?.adminUrl ? escapeHtml(data.projects[0].adminUrl.replace(/\/admin\/projects\/[^/]+/, '/admin/projects')) : '#'

  return renderEmailShell({
    companyName: data.companyName,
    companyLogoUrl: data.companyLogoUrl,
    headerGradient: data.emailHeaderColor || EMAIL_THEME.headerBackground,
    headerTextColor: (data.emailHeaderTextMode || 'LIGHT') === 'DARK' ? '#111827' : '#ffffff',
    title: 'Internal Comments Summary',
    subtitle: `${total} ${total === 1 ? 'comment' : 'comments'} across ${projectCount} ${projectCount === 1 ? 'project' : 'projects'} ${data.period}`,
    mainCompanyDomain: data.mainCompanyDomain,
    footerNote: data.companyName,
    bodyContent: `
      <p style="margin:0 0 20px; font-size:16px;">
        Hi <strong>${escapeHtml(greeting)}</strong>,
      </p>
      <p style="margin:0 0 24px; font-size:15px;">
        Here are the latest internal comments:
      </p>
      ${projectsHtml}
      <div style="text-align:center; margin:32px 0;">
        <a href="${dashboardUrl}" style="${emailPrimaryButtonStyle({ fontSizePx: 16, borderRadiusPx: 8, accent: data.accentColor, accentTextMode: data.accentTextMode })}">
          Open Admin Dashboard
        </a>
      </div>
    `,
  }).trim()
}

export interface ProjectInviteInternalUsersEmailData {
  companyName: string
  companyLogoUrl?: string
  mainCompanyDomain?: string | null
  accentColor?: string
  accentTextMode?: string
  emailHeaderColor?: string
  emailHeaderTextMode?: string
  recipientName?: string
  projectTitle: string
  projectAdminUrl: string
  notes?: string | null
  attachments?: Array<{ fileName: string; fileSizeBytes: number }>
}

export function generateProjectInviteInternalUsersEmail(data: ProjectInviteInternalUsersEmailData): string {
  const rawGreeting = data.recipientName ? data.recipientName : 'there'
  const greeting = firstWordName(rawGreeting) || rawGreeting
  const notes = (data.notes || '').trim()
  const attachments = Array.isArray(data.attachments) ? data.attachments : []

  const notesHtml = notes
    ? `
      <div style="${emailCardStyle({ paddingPx: 16, borderRadiusPx: 12, marginBottomPx: 16 })}">
        <div style="${emailCardTitleStyle()}">Notes</div>
        <div style="font-size:14px; color:#374151; line-height:1.6; white-space:pre-wrap;">${escapeHtml(notes)}</div>
      </div>
    `
    : ''

  const attachmentsHtml = attachments.length
    ? `
      <div style="${emailCardStyle({ paddingPx: 16, borderRadiusPx: 12, marginBottomPx: 16 })}">
        <div style="${emailCardTitleStyle()}">Attachments</div>
        <div style="font-size:14px; color:#374151; line-height:1.6;">
          ${attachments
            .map((a) => {
              const sizeMb = a.fileSizeBytes > 0 ? (a.fileSizeBytes / 1024 / 1024).toFixed(a.fileSizeBytes < 1024 * 1024 ? 2 : 1) : '0'
              return `<div style="padding:6px 0; border-top:1px solid #e5e7eb;">${escapeHtml(a.fileName)} <span style="color:#6b7280; font-size:12px;">(${sizeMb} MB)</span></div>`
            })
            .join('')}
        </div>
      </div>
    `
    : ''

  return renderEmailShell({
    companyName: data.companyName,
    companyLogoUrl: data.companyLogoUrl,
    headerGradient: data.emailHeaderColor || EMAIL_THEME.headerBackground,
    headerTextColor: (data.emailHeaderTextMode || 'LIGHT') === 'DARK' ? '#111827' : '#ffffff',
    title: 'Project Invite',
    subtitle: data.projectTitle,
    mainCompanyDomain: data.mainCompanyDomain,
    footerNote: data.companyName,
    bodyContent: `
      <p style="margin:0 0 16px; font-size:16px;">
        Hi <strong>${escapeHtml(greeting)}</strong>,
      </p>
      <p style="margin:0 0 24px; font-size:15px; color:#374151; line-height:1.6;">
        You’ve been invited to access the project <strong>${escapeHtml(data.projectTitle)}</strong>.
      </p>
      ${notesHtml}
      ${attachmentsHtml}
      <div style="text-align:center; margin:28px 0 8px;">
        <a href="${escapeHtml(data.projectAdminUrl)}" style="${emailPrimaryButtonStyle({ fontSizePx: 16, borderRadiusPx: 8, accent: data.accentColor, accentTextMode: data.accentTextMode })}">
          Open Project
        </a>
      </div>
      <p style="margin:0; font-size:12px; color:#6b7280; text-align:center;">
        If you can’t access the project, ask an admin to confirm you’re assigned.
      </p>
    `,
  }).trim()
}
