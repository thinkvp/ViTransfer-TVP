import nodemailer from 'nodemailer'
import { prisma } from './db'
import { decrypt } from './encryption'
import { normalizeHexDisplayColor } from './display-color'

export const EMAIL_THEME = {
  headerBackground: '#1F1F1F',
  accent: '#339CFF',

  pageBackground: '#f3f4f6',
  surface: '#ffffff',
  surfaceMuted: '#f9fafb',

  text: '#111827',
  textMuted: '#6b7280',
  textSubtle: '#9ca3af',
  border: '#e5e7eb',
} as const

const EMAIL_SELF_HOST_NOTICE_HTML =
  'We proudly self-host ViTransfer on our private server. The server may not be accessible during power or nbn outages.  If you are unable to access the server, please contact us for assistance.'

export function emailPrimaryButtonStyle({
  fontSizePx = 15,
  padding = '14px 32px',
  borderRadiusPx = 8,
}: {
  fontSizePx?: number
  padding?: string
  borderRadiusPx?: number
} = {}): string {
  return [
    'display:inline-block',
    `background:${EMAIL_THEME.accent}`,
    'color:#ffffff',
    'text-decoration:none',
    `padding:${padding}`,
    `border-radius:${borderRadiusPx}px`,
    `font-size:${fontSizePx}px`,
    'font-weight:600',
    'box-shadow:0 2px 4px rgba(51,156,255,0.25)',
  ].join(';')
}

export function emailCardStyle({
  paddingPx = 16,
  borderRadiusPx = 8,
  marginBottomPx = 24,
}: {
  paddingPx?: number
  borderRadiusPx?: number
  marginBottomPx?: number
} = {}): string {
  return [
    `background:${EMAIL_THEME.surfaceMuted}`,
    `border:1px solid ${EMAIL_THEME.border}`,
    `border-radius:${borderRadiusPx}px`,
    `padding:${paddingPx}px`,
    `margin-bottom:${marginBottomPx}px`,
  ].join(';')
}

export function emailCardTitleStyle(): string {
  return [
    'font-size:13px',
    'font-weight:600',
    `color:${EMAIL_THEME.textMuted}`,
    'margin-bottom:8px',
    'text-transform:uppercase',
    'letter-spacing:0.5px',
  ].join(';')
}

export function emailCalloutStyle({
  borderLeftPx = 3,
  marginBottomPx = 24,
  accentColor,
}: {
  borderLeftPx?: number
  marginBottomPx?: number
  accentColor?: string | null
} = {}): string {
  const resolvedAccentColor = normalizeHexDisplayColor(accentColor) || EMAIL_THEME.accent
  return [
    `background:${EMAIL_THEME.surfaceMuted}`,
    `border-left:${borderLeftPx}px solid ${resolvedAccentColor}`,
    `border-radius:8px`,
    'padding:16px',
    `margin-bottom:${marginBottomPx}px`,
  ].join(';')
}

/**
 * Escape HTML to prevent XSS and email injection
 */
export function escapeHtml(unsafe: string): string {
  if (!unsafe) return ''
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

/**
 * Sanitize string for email header use (defense-in-depth)
 * Removes CRLF and other header injection attempts
 */
function sanitizeEmailHeader(value: string): string {
  if (!value) return ''
  return value
    .replace(/[\r\n]/g, '') // Remove CRLF
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim()
}

export interface EmailShellOptions {
  companyName: string
  title: string
  subtitle?: string
  bodyContent: string
  footerNote?: string
  headerGradient: string
  companyLogoUrl?: string | null
  trackingToken?: string
  trackingPixelsEnabled?: boolean
  trackingPixelPath?: string
  appDomain?: string
}

export function buildCompanyLogoUrl({
  appDomain,
  companyLogoMode,
  companyLogoPath,
  companyLogoUrl,
  updatedAt,
}: {
  appDomain?: string | null
  companyLogoMode?: 'NONE' | 'UPLOAD' | 'LINK' | null
  companyLogoPath?: string | null
  companyLogoUrl?: string | null
  updatedAt?: Date
}): string | null {
  const mode = companyLogoMode || 'NONE'
  if (mode === 'NONE') return null

  if (mode === 'LINK') {
    const raw = (companyLogoUrl || '').trim()
    if (!raw) return null
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return raw
    } catch {
      return null
    }
  }

  // UPLOAD
  if (!companyLogoPath) return null
  const base = (appDomain || process.env.APP_DOMAIN || '').trim()
  if (!base) return null

  let origin: string
  try {
    const parsed = new URL(base)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    origin = parsed.origin
  } catch {
    return null
  }

  // Cache-bust for email clients using Settings.updatedAt.
  const version = updatedAt ? updatedAt.getTime() : Date.now()
  return `${origin}/api/branding/logo?v=${version}`
}

export function renderEmailShell({
  companyName,
  title,
  subtitle,
  bodyContent,
  footerNote,
  headerGradient,
  companyLogoUrl,
  trackingToken,
  trackingPixelsEnabled,
  trackingPixelPath,
  appDomain,
}: EmailShellOptions) {
  const rawDomain = (appDomain || process.env.APP_DOMAIN || '').trim()
  let trackingDomain: string | null = null
  if (rawDomain) {
    try {
      const parsed = new URL(rawDomain)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        trackingDomain = parsed.origin
      }
    } catch {
      trackingDomain = null
    }
  }

  const trackingPath = (trackingPixelPath || '/api/track/email').trim() || '/api/track/email'
  const trackingPixel = trackingPixelsEnabled && trackingToken && trackingDomain
    ? `<img src="${trackingDomain}${trackingPath}/${trackingToken}" width="1" height="1" alt="" style="display:block;border:0;" />`
    : ''
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 20px; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

    <!-- Header -->
    <div style="background: ${headerGradient}; padding: 32px 24px; text-align: center;">
      <div style="font-size: 24px; font-weight: 700; color: #ffffff; margin-bottom: 8px;">${escapeHtml(title)}</div>
      ${subtitle ? `<div style="font-size: 15px; color: rgba(255,255,255,0.95);">${escapeHtml(subtitle)}</div>` : ''}
    </div>

    ${companyLogoUrl ? `
    <!-- Logo -->
    <div style="padding: 24px 24px 0; text-align: center; background: #ffffff;">
      <img
        src="${escapeHtml(companyLogoUrl)}"
        alt="${escapeHtml(companyName)} logo"
        style="display:block; margin:0 auto; width:auto; max-width:300px; height:auto; border:0; outline:none; text-decoration:none;"
      />
      <div style="height: 20px; line-height: 20px;">&nbsp;</div>
    </div>
    ` : ''}

    <!-- Content -->
    <div style="padding: 32px 24px;">
      ${bodyContent}
    </div>

    <!-- Footer -->
    <div style="background: #f9fafb; padding: 20px 24px; border-top: 1px solid #e5e7eb; text-align: center;">
      <p style="margin: 0; font-size: 13px; color: #9ca3af;">
        ${escapeHtml(footerNote || companyName)}
      </p>
    </div>

  </div>
  ${trackingPixel}
</body>
</html>
  `
}

interface EmailSettings {
  smtpServer: string | null
  smtpPort: number | null
  smtpUsername: string | null
  smtpPassword: string | null
  smtpFromAddress: string | null
  smtpSecure: string | null
  appDomain: string | null
  companyName: string | null
  companyLogoMode: 'NONE' | 'UPLOAD' | 'LINK' | null
  companyLogoPath: string | null
  companyLogoUrl: string | null
  emailTrackingPixelsEnabled: boolean | null
  updatedAt?: Date
}

export interface RenderedEmail {
  subject: string
  html: string
  text?: string
}

export interface EmailBrandingOverrides {
  companyName?: string
  companyLogoUrl?: string | null
  trackingPixelsEnabled?: boolean
  appDomain?: string
}

async function resolveEmailBranding(
  overrides?: EmailBrandingOverrides
): Promise<{
  companyName: string
  companyLogoUrl: string | null
  trackingPixelsEnabled: boolean
  appDomain?: string
  settings?: EmailSettings
}> {
  if (overrides?.companyName && overrides.trackingPixelsEnabled != null) {
    return {
      companyName: overrides.companyName,
      companyLogoUrl: overrides.companyLogoUrl ?? null,
      trackingPixelsEnabled: overrides.trackingPixelsEnabled,
      appDomain: overrides.appDomain,
    }
  }

  const settings = await getEmailSettings()
  const companyName = overrides?.companyName || settings.companyName || 'Studio'
  const companyLogoUrl = overrides?.companyLogoUrl ?? buildCompanyLogoUrl({
    appDomain: overrides?.appDomain || settings.appDomain,
    companyLogoMode: settings.companyLogoMode,
    companyLogoPath: settings.companyLogoPath,
    companyLogoUrl: settings.companyLogoUrl,
    updatedAt: settings.updatedAt,
  })

  return {
    companyName,
    companyLogoUrl,
    trackingPixelsEnabled: overrides?.trackingPixelsEnabled ?? (settings.emailTrackingPixelsEnabled ?? true),
    appDomain: overrides?.appDomain || settings.appDomain || undefined,
    settings,
  }
}

let cachedSettings: EmailSettings | null = null
let settingsCacheTime: number = 0
const CACHE_DURATION = 30 * 1000 // 30 seconds (reduced for testing)

export function invalidateEmailSettingsCache() {
  cachedSettings = null
  settingsCacheTime = 0
}

/**
 * Get email settings from database with caching
 */
export async function getEmailSettings(): Promise<EmailSettings> {
  const now = Date.now()
  
  // Return cached settings if still valid
  if (cachedSettings && (now - settingsCacheTime) < CACHE_DURATION) {
    return cachedSettings
  }

  // Fetch fresh settings
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      smtpServer: true,
      smtpPort: true,
      smtpUsername: true,
      smtpPassword: true,
      smtpFromAddress: true,
      smtpSecure: true,
      appDomain: true,
      companyName: true,
      companyLogoMode: true,
      companyLogoPath: true,
      companyLogoUrl: true,
      emailTrackingPixelsEnabled: true,
      updatedAt: true,
    }
  })

  // Decrypt the password if it exists
  cachedSettings = settings ? {
    ...settings,
    smtpPassword: settings.smtpPassword ? decrypt(settings.smtpPassword) : null,
  } : {
    smtpServer: null,
    smtpPort: null,
    smtpUsername: null,
    smtpPassword: null,
    smtpFromAddress: null,
    smtpSecure: null,
    appDomain: null,
    companyName: null,
    companyLogoMode: null,
    companyLogoPath: null,
    companyLogoUrl: null,
    emailTrackingPixelsEnabled: null,
    updatedAt: undefined,
  }
  settingsCacheTime = now

  return cachedSettings
}

/**
 * Check if SMTP is properly configured
 */
export async function isSmtpConfigured(): Promise<boolean> {
  try {
    const settings = await getEmailSettings()
    return !!(settings.smtpServer && settings.smtpPort && settings.smtpUsername && settings.smtpPassword)
  } catch (error) {
    console.error('Error checking SMTP configuration:', error)
    return false
  }
}

/**
 * Create a nodemailer transporter with current SMTP settings or provided config
 */
async function createTransporter(customConfig?: any) {
  // Use custom config if provided, otherwise load from database
  const settings = customConfig || await getEmailSettings()

  if (!settings.smtpServer || !settings.smtpPort || !settings.smtpUsername || !settings.smtpPassword) {
    throw new Error('SMTP settings are not configured. Please configure email settings in the admin panel.')
  }

  // Determine secure settings based on smtpSecure option
  const secureOption = settings.smtpSecure || 'STARTTLS'
  let secure = false
  let requireTLS = false

  if (secureOption === 'TLS') {
    secure = true // Use SSL/TLS (port 465)
  } else if (secureOption === 'STARTTLS') {
    secure = false // Use STARTTLS (port 587)
    requireTLS = true
  } else {
    secure = false // No encryption
    requireTLS = false
  }

  return nodemailer.createTransport({
    host: settings.smtpServer,
    port: settings.smtpPort,
    secure: secure,
    requireTLS: requireTLS,
    auth: {
      user: settings.smtpUsername,
      pass: settings.smtpPassword,
    },
  })
}

/**
 * Send an email
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments,
}: {
  to: string
  subject: string
  html: string
  text?: string
  attachments?: nodemailer.SendMailOptions['attachments']
}) {
  try {
    const settings = await getEmailSettings()
    const transporter = await createTransporter()

    const fromAddress = settings.smtpFromAddress || settings.smtpUsername || 'noreply@vitransfer.com'
    const companyName = sanitizeEmailHeader(settings.companyName || 'ViTransfer')

    const info = await transporter.sendMail({
      from: `"${companyName}" <${fromAddress}>`,
      to,
      subject,
      text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML for text version
      html,
      attachments,
    })

    return { success: true, messageId: info.messageId }
  } catch (error) {
    console.error('Error sending email:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

/**
 * Email template: New version uploaded
 */
function renderNotesCard(notes: string | null | undefined, opts: { cardStyle: string; cardTitleStyle: string }) {
  if (!notes || !notes.trim()) return ''
  return `
    <div style="${opts.cardStyle}">
      <div style="${opts.cardTitleStyle}">Notes</div>
      <div style="font-size: 15px; color: #111827; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(notes)}</div>
    </div>
  `
}

export async function renderNewVersionEmail({
  clientName,
  projectTitle,
  videoName,
  versionLabel,
  videoNotes,
  shareUrl,
  isPasswordProtected = false,
  trackingToken,
  branding,
}: {
  clientName: string
  projectTitle: string
  videoName: string
  versionLabel: string
  videoNotes?: string | null
  shareUrl: string
  isPasswordProtected?: boolean
  trackingToken?: string
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const subject = `New Version Available: ${projectTitle}`

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const cardTitleStyle = emailCardTitleStyle()

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: 'New Version Available',
    subtitle: 'Ready for your review',
    trackingToken,
    trackingPixelsEnabled: resolved.trackingPixelsEnabled,
    appDomain: resolved.appDomain,
    bodyContent: `
      <p style="margin: 0 0 20px 0; font-size: 16px; color: #111827; line-height: 1.5;">
        Hi <strong>${escapeHtml(clientName)}</strong>,
      </p>

      <p style="margin: 0 0 24px 0; font-size: 15px; color: #374151; line-height: 1.6;">
        A new version of a video in your project is ready. Please review and provide any feedback. If no changes are required you can approve the video for the download.
      </p>

      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Project Details</div>
        <div style="font-size: 15px; color: #111827; padding: 4px 0;">
          <strong>${escapeHtml(projectTitle)}</strong>
        </div>
        <div style="font-size: 14px; color: #374151; padding: 4px 0;">
          ${escapeHtml(videoName)} <span style="color: ${EMAIL_THEME.accent};">${escapeHtml(versionLabel)}</span>
        </div>
      </div>

      ${renderNotesCard(videoNotes, { cardStyle, cardTitleStyle })}

      ${isPasswordProtected ? `
        <div style="${cardStyle}">
          <div style="font-size: 14px; color: #374151; line-height: 1.5;">
            <strong>Password Protected:</strong> Use the password previously sent to you to access this project.
          </div>
        </div>
      ` : ''}

      <div style="text-align: center; margin: 32px 0;">
        <a href="${escapeHtml(shareUrl)}" style="${primaryButtonStyle}">
          View Project
        </a>
      </div>

      <p style="margin: 32px 0 0 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
        ${EMAIL_SELF_HOST_NOTICE_HTML}
      </p>
    `,
  })

  return { subject, html }
}

export async function sendNewVersionEmail({
  clientEmail,
  clientName,
  projectTitle,
  videoName,
  versionLabel,
  videoNotes,
  shareUrl,
  isPasswordProtected = false,
  trackingToken,
}: {
  clientEmail: string
  clientName: string
  projectTitle: string
  videoName: string
  versionLabel: string
  videoNotes?: string | null
  shareUrl: string
  isPasswordProtected?: boolean
  trackingToken?: string
}) {
  const { subject, html } = await renderNewVersionEmail({
    clientName,
    projectTitle,
    videoName,
    versionLabel,
    videoNotes,
    shareUrl,
    isPasswordProtected,
    trackingToken,
  })

  return sendEmail({
    to: clientEmail,
    subject,
    html,
  })
}

/**
 * Email template: New album available
 */
export async function renderNewAlbumReadyEmail({
  clientName,
  projectTitle,
  albumName,
  albumNotes,
  shareUrl,
  isPasswordProtected = false,
  trackingToken,
  branding,
}: {
  clientName: string
  projectTitle: string
  albumName: string
  albumNotes?: string | null
  shareUrl: string
  isPasswordProtected?: boolean
  trackingToken?: string
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const subject = `New Album Available: ${projectTitle}`

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const cardTitleStyle = emailCardTitleStyle()

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: 'New Album Available',
    subtitle: 'Ready for your review',
    trackingToken,
    trackingPixelsEnabled: resolved.trackingPixelsEnabled,
    appDomain: resolved.appDomain,
    bodyContent: `
      <p style="margin: 0 0 20px 0; font-size: 16px; color: #111827; line-height: 1.5;">
        Hi <strong>${escapeHtml(clientName)}</strong>,
      </p>

      <p style="margin: 0 0 24px 0; font-size: 15px; color: #374151; line-height: 1.6;">
        A new album for your project is ready.
      </p>

      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Project Details</div>
        <div style="font-size: 15px; color: #111827; padding: 4px 0;">
          <strong>${escapeHtml(projectTitle)}</strong>
        </div>
        <div style="font-size: 14px; color: #374151; padding: 4px 0;">
          ${escapeHtml(albumName)}
        </div>
      </div>

      ${renderNotesCard(albumNotes || null, { cardStyle, cardTitleStyle })}

      ${isPasswordProtected ? `
        <div style="${cardStyle}">
          <div style="font-size: 14px; color: #374151; line-height: 1.5;">
            <strong>Password Protected:</strong> Use the password previously sent to you to access this project.
          </div>
        </div>
      ` : ''}

      <div style="text-align: center; margin: 32px 0;">
        <a href="${escapeHtml(shareUrl)}" style="${primaryButtonStyle}">
          View Project
        </a>
      </div>

      <p style="margin: 32px 0 0 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
        ${EMAIL_SELF_HOST_NOTICE_HTML}
      </p>
    `,
  })

  return { subject, html }
}

export async function sendNewAlbumReadyEmail({
  clientEmail,
  clientName,
  projectTitle,
  albumName,
  albumNotes,
  shareUrl,
  isPasswordProtected = false,
  trackingToken,
}: {
  clientEmail: string
  clientName: string
  projectTitle: string
  albumName: string
  albumNotes?: string | null
  shareUrl: string
  isPasswordProtected?: boolean
  trackingToken?: string
}) {
  const { subject, html } = await renderNewAlbumReadyEmail({
    clientName,
    projectTitle,
    albumName,
    albumNotes,
    shareUrl,
    isPasswordProtected,
    trackingToken,
  })

  return sendEmail({
    to: clientEmail,
    subject,
    html,
  })
}

/**
 * Email template: Project approved
 */
export async function renderProjectApprovedEmail({
  clientName,
  projectTitle,
  shareUrl,
  approvedVideos = [],
  isComplete = true,
  autoCloseInfo,
  branding,
}: {
  clientName: string
  projectTitle: string
  shareUrl: string
  approvedVideos?: Array<{ name: string; id: string }>
  isComplete?: boolean
  autoCloseInfo?: { closeDate: Date; days: number } | null
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const subject = isComplete
    ? `${projectTitle} - Project Approved and Ready for Download`
    : `${projectTitle} - Video Approved`

  const statusTitle = isComplete ? 'Project Approved' : 'Video Approved'
  const statusMessage = isComplete
    ? 'All videos are approved and ready to deliver'
    : `${approvedVideos[0]?.name || 'Your video'} has been approved`

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const cardTitleStyle = emailCardTitleStyle()

  const formatLongDate = (date: Date): string => {
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ]
    const d = date.getDate()
    const m = months[date.getMonth()] || ''
    const y = date.getFullYear()
    return `${d} ${m} ${y}`.trim()
  }

  const autoCloseCalloutHtml = autoCloseInfo && autoCloseInfo.days > 0
    ? `
      <div style="background:#663F00; border:2px solid #663F00; border-radius:8px; padding:16px; margin: 0 0 24px 0;">
        <div style="font-size: 14px; color: #FF9805; line-height: 1.6;">
          <strong style="color:#FF9805;">Auto-close enabled:</strong> This project will automatically close on <strong style="color:#FF9805;">${escapeHtml(formatLongDate(autoCloseInfo.closeDate))}</strong>. Please download your video/s before this date.
        </div>
      </div>
    `
    : ''

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: statusTitle,
    subtitle: statusMessage,
    trackingPixelsEnabled: resolved.trackingPixelsEnabled,
    appDomain: resolved.appDomain,
    bodyContent: `
      <p style="margin: 0 0 20px 0; font-size: 16px; color: #111827; line-height: 1.5;">
        Hi <strong>${escapeHtml(clientName)}</strong>,
      </p>

      <p style="margin: 0 0 24px 0; font-size: 15px; color: #374151; line-height: 1.6;">
        Great news! Your project <strong>${escapeHtml(projectTitle)}</strong> has been approved. You can now download the final version without watermarks.
      </p>

      ${autoCloseCalloutHtml}

      ${approvedVideos.length > 0 ? `
        <div style="${cardStyle}">
          <div style="${cardTitleStyle}">Approved Videos</div>
          ${approvedVideos.map(v => `
            <div style="font-size: 15px; color: #374151; padding: 4px 0;">
              <span style="display: inline-block; width: 6px; height: 6px; background: ${EMAIL_THEME.accent}; border-radius: 50%; margin-right: 8px;"></span>${escapeHtml(v.name)}
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div style="text-align: center; margin: 32px 0;">
        <a href="${escapeHtml(shareUrl)}" style="${primaryButtonStyle}">
          Download Now
        </a>
      </div>

      <p style="margin: 32px 0 0 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
        ${EMAIL_SELF_HOST_NOTICE_HTML}
      </p>
    `,
  })

  return { subject, html }
}

export async function sendProjectApprovedEmail({
  clientEmail,
  clientName,
  projectTitle,
  shareUrl,
  approvedVideos = [],
  isComplete = true,
  autoCloseInfo,
}: {
  clientEmail: string
  clientName: string
  projectTitle: string
  shareUrl: string
  approvedVideos?: Array<{ name: string; id: string }>
  isComplete?: boolean
  autoCloseInfo?: { closeDate: Date; days: number } | null
}) {
  const { subject, html } = await renderProjectApprovedEmail({
    clientName,
    projectTitle,
    shareUrl,
    approvedVideos,
    isComplete,
    autoCloseInfo,
  })

  return sendEmail({
    to: clientEmail,
    subject,
    html,
  })
}

/**
 * Email template: Single comment notification (to clients)
 */
export async function renderCommentNotificationEmail({
  clientName,
  projectTitle,
  videoName,
  versionLabel,
  authorName,
  commentContent,
  timecode,
  shareUrl,
  displayColor,
  trackingToken,
  unsubscribeUrl,
  branding,
}: {
  clientName: string
  projectTitle: string
  videoName: string
  versionLabel: string
  authorName: string
  commentContent: string
  timecode?: string | null
  shareUrl: string
  displayColor?: string | null
  trackingToken?: string
  unsubscribeUrl?: string
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const subject = `New Comment: ${projectTitle}`
  const timecodeText = timecode ? `at ${timecode}` : ''

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const cardTitleStyle = emailCardTitleStyle()
  const calloutStyle = emailCalloutStyle({ borderLeftPx: 3, accentColor: displayColor || null })

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: 'New Comment',
    subtitle: `${resolved.companyName} left feedback on your video`,
    trackingToken,
    trackingPixelsEnabled: resolved.trackingPixelsEnabled,
    appDomain: resolved.appDomain,
    bodyContent: `
      <p style="margin: 0 0 20px 0; font-size: 16px; color: #111827; line-height: 1.5;">
        Hi <strong>${escapeHtml(clientName)}</strong>,
      </p>

      <p style="margin: 0 0 24px 0; font-size: 15px; color: #374151; line-height: 1.6;">
        We've reviewed your video and left some feedback for you.
      </p>

      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Project</div>
        <div style="font-size: 15px; color: #111827; margin-bottom: 8px;">
          <strong>${escapeHtml(projectTitle)}</strong>
        </div>
        <div style="font-size: 14px; color: #6b7280;">
          ${escapeHtml(videoName)} <span style="color: #9ca3af;">${escapeHtml(versionLabel)}</span>${timecodeText ? ` <span style="color: #9ca3af;">• ${timecodeText}</span>` : ''}
        </div>
      </div>

      <div style="${calloutStyle}">
        <div style="font-size: 13px; font-weight: 600; color: ${EMAIL_THEME.text}; margin-bottom: 8px;">${escapeHtml(authorName)}</div>
        <div style="font-size: 15px; color: #374151; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(commentContent)}</div>
      </div>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${escapeHtml(shareUrl)}" style="${primaryButtonStyle}">
          View and Reply
        </a>
      </div>

      ${unsubscribeUrl ? `
        <p style="margin:24px 0 0; font-size:13px; color:#9ca3af; text-align:center; line-height:1.5;">
          Don't want to receive updates for this project? <a href="${escapeHtml(unsubscribeUrl)}" style="color:${EMAIL_THEME.accent}; text-decoration:underline;">Unsubscribe</a>
        </p>
      ` : ''}

      <p style="margin: 32px 0 0 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
        ${EMAIL_SELF_HOST_NOTICE_HTML}
      </p>
    `,
  })

  return { subject, html }
}

export async function sendCommentNotificationEmail({
  clientEmail,
  clientName,
  projectTitle,
  videoName,
  versionLabel,
  authorName,
  commentContent,
  timecode,
  shareUrl,
  displayColor,
  trackingToken,
  unsubscribeUrl,
}: {
  clientEmail: string
  clientName: string
  projectTitle: string
  videoName: string
  versionLabel: string
  authorName: string
  commentContent: string
  timecode?: string | null
  shareUrl: string
  displayColor?: string | null
  trackingToken?: string
  unsubscribeUrl?: string
}) {
  const { subject, html } = await renderCommentNotificationEmail({
    clientName,
    projectTitle,
    videoName,
    versionLabel,
    authorName,
    commentContent,
    timecode,
    shareUrl,
    displayColor,
    trackingToken,
    unsubscribeUrl,
  })

  return sendEmail({
    to: clientEmail,
    subject,
    html,
  })
}

/**
 * Email template: Single comment notification (to admins)
 */
export async function renderAdminCommentNotificationEmail({
  clientName,
  clientEmail,
  projectTitle,
  videoName,
  versionLabel,
  commentContent,
  timecode,
  shareUrl,
  displayColor,
  branding,
}: {
  clientName: string
  clientEmail?: string | null
  projectTitle: string
  videoName: string
  versionLabel: string
  commentContent: string
  timecode?: string | null
  shareUrl: string
  displayColor?: string | null
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const subject = `Client Feedback: ${projectTitle}`
  const timecodeText = timecode ? `at ${timecode}` : ''

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const cardTitleStyle = emailCardTitleStyle()
  const calloutStyle = emailCalloutStyle({ borderLeftPx: 3, accentColor: displayColor || null })

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: 'New Client Feedback',
    subtitle: 'Your client left a comment',
    trackingPixelsEnabled: resolved.trackingPixelsEnabled,
    appDomain: resolved.appDomain,
    bodyContent: `
      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Client</div>
        <div style="font-size: 16px; color: #111827; margin-bottom: 4px;">
          <strong>${escapeHtml(clientName)}</strong>
        </div>
        ${clientEmail ? `
          <div style="font-size: 14px; color: #6b7280;">
            ${escapeHtml(clientEmail)}
          </div>
        ` : ''}
      </div>

      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Project</div>
        <div style="font-size: 15px; color: #111827; margin-bottom: 8px;">
          <strong>${escapeHtml(projectTitle)}</strong>
        </div>
        <div style="font-size: 14px; color: #6b7280;">
          ${escapeHtml(videoName)} <span style="color: #9ca3af;">${escapeHtml(versionLabel)}</span>${timecodeText ? ` <span style="color: #9ca3af;">• ${timecodeText}</span>` : ''}
        </div>
      </div>

      <div style="${calloutStyle}">
        <div style="font-size: 13px; font-weight: 600; color: ${EMAIL_THEME.text}; margin-bottom: 8px;">Comment</div>
        <div style="font-size: 15px; color: #374151; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(commentContent)}</div>
      </div>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${escapeHtml(shareUrl)}" style="${primaryButtonStyle}">
          View in Admin Panel
        </a>
      </div>
    `,
  })

  return { subject, html }
}

export async function sendAdminCommentNotificationEmail({
  adminEmails,
  clientName,
  clientEmail,
  projectTitle,
  videoName,
  versionLabel,
  commentContent,
  timecode,
  shareUrl,
  displayColor,
}: {
  adminEmails: string[]
  clientName: string
  clientEmail?: string | null
  projectTitle: string
  videoName: string
  versionLabel: string
  commentContent: string
  timecode?: string | null
  shareUrl: string
  displayColor?: string | null
}) {
  const { subject, html } = await renderAdminCommentNotificationEmail({
    clientName,
    clientEmail,
    projectTitle,
    videoName,
    versionLabel,
    commentContent,
    timecode,
    shareUrl,
    displayColor,
  })

  // Send to all admin emails
  const promises = adminEmails.map(email =>
    sendEmail({
      to: email,
      subject,
      html,
    })
  )

  const results = await Promise.allSettled(promises)
  const successCount = results.filter(r => r.status === 'fulfilled').length

  return {
    success: successCount > 0,
    message: `Sent to ${successCount}/${adminEmails.length} admins`
  }
}

/**
 * Email template: Project approved by client (to admin)
 */
export async function renderAdminProjectApprovedEmail({
  clientName,
  projectTitle,
  approvedVideos = [],
  isComplete = true,
  isApproval = true,
  greetingName,
  branding,
}: {
  clientName: string
  projectTitle: string
  approvedVideos?: Array<{ name: string; id: string }>
  isComplete?: boolean
  isApproval?: boolean
  greetingName?: string
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)
  const appDomain = resolved.appDomain

  if (!appDomain) {
    throw new Error('App domain not configured. Please configure domain in Settings to enable email notifications.')
  }

  const action = isApproval ? 'Approved' : 'Unapproved'
  const subject = isComplete
    ? `Client ${action} Project: ${projectTitle}`
    : `Client ${action} Video: ${projectTitle} - ${approvedVideos[0]?.name || 'Video'}`

  const statusTitle = isComplete ? `Project ${action}` : `Video ${action}`
  const statusMessage = isComplete
    ? `The complete project has been ${isApproval ? 'approved' : 'unapproved'} by the client`
    : `${approvedVideos[0]?.name || 'A video'} has been ${isApproval ? 'approved' : 'unapproved'} by the client`

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const cardTitleStyle = emailCardTitleStyle()

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: statusTitle,
    subtitle: statusMessage,
    trackingPixelsEnabled: resolved.trackingPixelsEnabled,
    appDomain,
    bodyContent: `
      <p style="margin: 0 0 20px 0; font-size: 16px; color: #111827; line-height: 1.5;">
        Hi <strong>${escapeHtml(greetingName || 'there')}</strong>,
      </p>

      <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151; line-height: 1.5;">
        Client: <strong>${escapeHtml(clientName)}</strong>
      </p>

      ${approvedVideos.length > 0 ? `
        <div style="${cardStyle}">
          <div style="${cardTitleStyle}">${isApproval ? 'Approved' : 'Unapproved'} Videos</div>
          ${approvedVideos.map(v => `
            <div style="font-size: 15px; color: #374151; padding: 4px 0;">
              <span style="display: inline-block; width: 6px; height: 6px; background: ${EMAIL_THEME.accent}; border-radius: 50%; margin-right: 8px;"></span>${escapeHtml(v.name)}
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div style="text-align: center; margin: 32px 0;">
        <a href="${escapeHtml(appDomain)}/admin" style="${primaryButtonStyle}">
          View in Admin Panel
        </a>
      </div>
    `,
  })

  return { subject, html }
}

export async function sendAdminProjectApprovedEmail({
  adminEmails,
  clientName,
  projectTitle,
  approvedVideos = [],
  isComplete = true,
  isApproval = true,
}: {
  adminEmails: string[]
  clientName: string
  projectTitle: string
  approvedVideos?: Array<{ name: string; id: string }>
  isComplete?: boolean
  isApproval?: boolean
}) {
  const uniqueEmails = [...new Set(adminEmails.map((e) => String(e || '').trim()).filter(Boolean))]
  const users = await prisma.user.findMany({
    where: { email: { in: uniqueEmails } },
    select: { email: true, name: true },
  })
  const nameByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.name]))

  const promises = uniqueEmails.map(async (email) => {
    const nameFromDb = nameByEmail.get(email.toLowerCase())
    const fallback = email.split('@')[0] || 'there'
    const greetingName = (nameFromDb && nameFromDb.trim()) ? nameFromDb.trim() : fallback

    const { subject, html } = await renderAdminProjectApprovedEmail({
      clientName,
      projectTitle,
      approvedVideos,
      isComplete,
      isApproval,
      greetingName,
    })

    return sendEmail({
      to: email,
      subject,
      html,
    })
  })

  const results = await Promise.allSettled(promises)
  const successCount = results.filter(r => r.status === 'fulfilled').length

  return {
    success: successCount > 0,
    message: `Sent to ${successCount}/${uniqueEmails.length} admins`
  }
}

/**
 * Email template: Invoice paid (to admins assigned to the project)
 * Note: explicitly disables tracking pixels.
 */
export async function renderAdminInvoicePaidEmail({
  greetingName,
  projectTitle,
  invoiceNumber,
  clientName,
  currency,
  invoiceAmountCents,
  feeAmountCents,
  totalAmountCents,
  paidAtYmd,
  publicInvoiceUrl,
  projectAdminUrl,
  branding,
}: {
  greetingName?: string
  projectTitle?: string | null
  invoiceNumber: string
  clientName?: string | null
  currency?: string | null
  invoiceAmountCents: number
  feeAmountCents?: number | null
  totalAmountCents?: number | null
  paidAtYmd?: string | null
  publicInvoiceUrl?: string | null
  projectAdminUrl?: string | null
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const ccy = (currency || 'AUD').toString().toUpperCase()
  const fmt = (cents: number | null | undefined): string => {
    const n = Number(cents)
    const safe = Number.isFinite(n) ? Math.round(n) : 0
    return `${ccy} ${(safe / 100).toFixed(2)}`
  }

  const subject = `Invoice Paid: ${invoiceNumber}`

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const cardTitleStyle = emailCardTitleStyle()

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: 'Invoice Paid',
    subtitle: 'A customer has paid an invoice',
    trackingPixelsEnabled: false,
    appDomain: resolved.appDomain,
    bodyContent: `
      <p style="margin: 0 0 18px 0; font-size: 16px; color: #111827; line-height: 1.5;">
        Hi <strong>${escapeHtml(greetingName || 'there')}</strong>,
      </p>

      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Invoice</div>
        <div style="font-size: 16px; color: #111827; margin-bottom: 6px;">
          <strong>${escapeHtml(invoiceNumber)}</strong>
          ${paidAtYmd ? `<span style="color:#9ca3af;"> • Paid ${escapeHtml(paidAtYmd)}</span>` : ''}
        </div>
        ${clientName ? `<div style="font-size: 14px; color: #6b7280;">Client: ${escapeHtml(clientName)}</div>` : ''}
        ${projectTitle ? `<div style="font-size: 14px; color: #6b7280; margin-top: 4px;">Project: ${escapeHtml(projectTitle)}</div>` : ''}
      </div>

      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Payment</div>
        <div style="font-size: 14px; color: #374151; line-height: 1.6;">
          Applied to invoice: <strong>${escapeHtml(fmt(invoiceAmountCents))}</strong><br />
          ${feeAmountCents && feeAmountCents > 0 ? `Fee: ${escapeHtml(fmt(feeAmountCents))}<br />` : ''}
          ${totalAmountCents && totalAmountCents > 0 ? `Total collected: <strong>${escapeHtml(fmt(totalAmountCents))}</strong>` : ''}
        </div>
      </div>

      ${(publicInvoiceUrl || projectAdminUrl) ? `
        <div style="text-align: center; margin: 28px 0;">
          ${publicInvoiceUrl ? `<a href="${escapeHtml(publicInvoiceUrl)}" style="${primaryButtonStyle}">View Paid Invoice</a>` : ''}
          ${projectAdminUrl ? `<div style="margin-top: 12px;"><a href="${escapeHtml(projectAdminUrl)}" style="font-size: 14px; color: ${EMAIL_THEME.accent}; text-decoration: none;">Open Project</a></div>` : ''}
        </div>
      ` : ''}
    `,
  })

  return { subject, html }
}

export async function sendAdminInvoicePaidEmail({
  adminEmails,
  projectTitle,
  invoiceNumber,
  clientName,
  currency,
  invoiceAmountCents,
  feeAmountCents,
  totalAmountCents,
  paidAtYmd,
  publicInvoiceUrl,
  projectAdminUrl,
}: {
  adminEmails: string[]
  projectTitle?: string | null
  invoiceNumber: string
  clientName?: string | null
  currency?: string | null
  invoiceAmountCents: number
  feeAmountCents?: number | null
  totalAmountCents?: number | null
  paidAtYmd?: string | null
  publicInvoiceUrl?: string | null
  projectAdminUrl?: string | null
}) {
  const uniqueEmails = [...new Set(adminEmails.map((e) => String(e || '').trim()).filter(Boolean))]
  if (!uniqueEmails.length) {
    return { success: false, message: 'No admin recipients' }
  }

  const users = await prisma.user.findMany({
    where: { email: { in: uniqueEmails } },
    select: { email: true, name: true },
  })
  const nameByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.name]))

  const promises = uniqueEmails.map(async (email) => {
    const nameFromDb = nameByEmail.get(email.toLowerCase())
    const fallback = email.split('@')[0] || 'there'
    const greetingName = (nameFromDb && nameFromDb.trim()) ? nameFromDb.trim() : fallback

    const { subject, html } = await renderAdminInvoicePaidEmail({
      greetingName,
      projectTitle,
      invoiceNumber,
      clientName,
      currency,
      invoiceAmountCents,
      feeAmountCents,
      totalAmountCents,
      paidAtYmd,
      publicInvoiceUrl,
      projectAdminUrl,
    })

    return sendEmail({ to: email, subject, html })
  })

  const results = await Promise.allSettled(promises)
  const successCount = results.filter((r) => r.status === 'fulfilled').length

  return {
    success: successCount > 0,
    message: `Sent to ${successCount}/${uniqueEmails.length} admins`,
  }
}

/**
 * Email template: Quote accepted (to admins)
 * Note: explicitly disables tracking pixels.
 */
export async function renderAdminQuoteAcceptedEmail({
  greetingName,
  quoteNumber,
  clientName,
  projectTitle,
  acceptedAtYmd,
  publicQuoteUrl,
  adminQuoteUrl,
  branding,
}: {
  greetingName?: string
  quoteNumber?: string | null
  clientName?: string | null
  projectTitle?: string | null
  acceptedAtYmd?: string | null
  publicQuoteUrl?: string | null
  adminQuoteUrl?: string | null
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const quoteLabel = (quoteNumber || '').trim() || 'Quote'
  const subject = quoteNumber ? `Quote Accepted: ${quoteNumber}` : 'Quote Accepted'

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ borderRadiusPx: 8 })
  const cardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const cardTitleStyle = emailCardTitleStyle()

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: 'Quote Accepted',
    subtitle: 'A customer has accepted a quote',
    trackingPixelsEnabled: false,
    appDomain: resolved.appDomain,
    bodyContent: `
      <p style="margin: 0 0 18px 0; font-size: 16px; color: #111827; line-height: 1.5;">
        Hi <strong>${escapeHtml(greetingName || 'there')}</strong>,
      </p>

      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Quote</div>
        <div style="font-size: 16px; color: #111827; margin-bottom: 6px;">
          <strong>${escapeHtml(quoteLabel)}</strong>
          ${acceptedAtYmd ? `<span style="color:#9ca3af;"> • Accepted ${escapeHtml(acceptedAtYmd)}</span>` : ''}
        </div>
        ${clientName ? `<div style="font-size: 14px; color: #6b7280;">Client: ${escapeHtml(clientName)}</div>` : ''}
        ${projectTitle ? `<div style="font-size: 14px; color: #6b7280; margin-top: 4px;">Project: ${escapeHtml(projectTitle)}</div>` : ''}
      </div>

      ${(publicQuoteUrl || adminQuoteUrl) ? `
        <div style="text-align: center; margin: 28px 0;">
          ${publicQuoteUrl ? `<a href="${escapeHtml(publicQuoteUrl)}" style="${primaryButtonStyle}">View Quote</a>` : ''}
          ${adminQuoteUrl ? `<div style="margin-top: 12px;"><a href="${escapeHtml(adminQuoteUrl)}" style="font-size: 14px; color: ${EMAIL_THEME.accent}; text-decoration: none;">Open in Admin</a></div>` : ''}
        </div>
      ` : ''}
    `,
  })

  return { subject, html }
}

export async function sendAdminQuoteAcceptedEmail({
  adminEmails,
  quoteNumber,
  clientName,
  projectTitle,
  acceptedAtYmd,
  publicQuoteUrl,
  adminQuoteUrl,
}: {
  adminEmails: string[]
  quoteNumber?: string | null
  clientName?: string | null
  projectTitle?: string | null
  acceptedAtYmd?: string | null
  publicQuoteUrl?: string | null
  adminQuoteUrl?: string | null
}) {
  const uniqueEmails = [...new Set(adminEmails.map((e) => String(e || '').trim()).filter(Boolean))]
  if (!uniqueEmails.length) {
    return { success: false, message: 'No admin recipients' }
  }

  const users = await prisma.user.findMany({
    where: { email: { in: uniqueEmails } },
    select: { email: true, name: true },
  })
  const nameByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.name]))

  const promises = uniqueEmails.map(async (email) => {
    const nameFromDb = nameByEmail.get(email.toLowerCase())
    const fallback = email.split('@')[0] || 'there'
    const greetingName = (nameFromDb && nameFromDb.trim()) ? nameFromDb.trim() : fallback

    const { subject, html } = await renderAdminQuoteAcceptedEmail({
      greetingName,
      quoteNumber,
      clientName,
      projectTitle,
      acceptedAtYmd,
      publicQuoteUrl,
      adminQuoteUrl,
    })

    return sendEmail({ to: email, subject, html })
  })

  const results = await Promise.allSettled(promises)
  const successCount = results.filter((r) => r.status === 'fulfilled').length

  return {
    success: successCount > 0,
    message: `Sent to ${successCount}/${uniqueEmails.length} admins`,
  }
}

/**
 * Email template: General project notification (entire project with all ready videos)
 */
export async function renderProjectGeneralNotificationEmail({
  clientName,
  projectTitle,
  shareUrl,
  readyVideos = [],
  readyAlbums = [],
  notes,
  isPasswordProtected = false,
  trackingToken,
  branding,
}: {
  clientName: string
  projectTitle: string
  shareUrl: string
  readyVideos?: Array<{ name: string; versionLabel: string }>
  readyAlbums?: Array<{ name: string; photoCount: number }>
  notes?: string | null
  isPasswordProtected?: boolean
  trackingToken?: string
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const subject = `Project Ready for Review: ${escapeHtml(projectTitle)}`

  const passwordNotice = isPasswordProtected
    ? `<div style="${emailCardStyle({ paddingPx: 14, borderRadiusPx: 10, marginBottomPx: 14 })}">
        Password protected. Use the password sent separately to open the link.
      </div>`
    : ''

  const videosList = readyVideos.length > 0
    ? `<div style="${emailCardStyle({ paddingPx: 14, borderRadiusPx: 10, marginBottomPx: 14 })}">
        <div style="font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:${EMAIL_THEME.textMuted}; margin-bottom:6px;">Ready to view</div>
        ${readyVideos.map(v => `<div style="font-size:15px; color:${EMAIL_THEME.text}; padding:4px 0;">${escapeHtml(v.name)} <span style="color:${EMAIL_THEME.accent};">${escapeHtml(v.versionLabel)}</span></div>`).join('')}
      </div>`
    : ''

  const headerGradient = EMAIL_THEME.headerBackground
  const primaryButtonStyle = emailPrimaryButtonStyle({ fontSizePx: 16, borderRadiusPx: 8 })
  const notesCardStyle = emailCardStyle({ borderRadiusPx: 8 })
  const notesCardTitleStyle = emailCardTitleStyle()

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: 'Project Ready for Review',
    subtitle: projectTitle,
    trackingToken,
    trackingPixelsEnabled: resolved.trackingPixelsEnabled,
    appDomain: resolved.appDomain,
    bodyContent: `
      <p style="margin:0 0 20px; font-size:16px;">
        Hi <strong>${escapeHtml(clientName)}</strong>,
      </p>
      <p style="margin:0 0 24px; font-size:15px;">
        Your project is ready for review. Click below to view and leave feedback.
      </p>
      ${renderNotesCard(notes, { cardStyle: notesCardStyle, cardTitleStyle: notesCardTitleStyle })}
      ${readyVideos.length > 0 || readyAlbums.length > 0 ? `
        <div style="${emailCardStyle({ paddingPx: 20, borderRadiusPx: 8, marginBottomPx: 24 })}">
          <div style="${emailCardTitleStyle()}">Ready to View</div>
          ${readyVideos.length > 0 ? `
            <div style="font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:${EMAIL_THEME.textMuted}; margin-top:2px; margin-bottom:8px;">Videos</div>
            ${readyVideos.map(v => `
              <div style="font-size:15px; color:#374151; padding:6px 0;">
                • ${escapeHtml(v.name)} <span style="color:${EMAIL_THEME.accent};">${escapeHtml(v.versionLabel)}</span>
              </div>
            `).join('')}
          ` : ''}

          ${readyAlbums.length > 0 ? `
            <div style="font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:${EMAIL_THEME.textMuted}; margin-top:${readyVideos.length > 0 ? 14 : 2}px; margin-bottom:8px;">Albums</div>
            ${readyAlbums.map(a => `
              <div style="font-size:15px; color:#374151; padding:6px 0;">
                • ${escapeHtml(a.name)} <span style="color:${EMAIL_THEME.textMuted};">(${Number(a.photoCount) || 0} photos)</span>
              </div>
            `).join('')}
          ` : ''}
        </div>
      ` : ''}
      ${passwordNotice}
      <div style="text-align:center; margin:32px 0;">
        <a href="${escapeHtml(shareUrl)}" style="${primaryButtonStyle}">
          View Project
        </a>
      </div>

      <p style="margin: 32px 0 0 0; font-size: 13px; color: ${EMAIL_THEME.textMuted}; line-height: 1.6; text-align: center;">
        ${EMAIL_SELF_HOST_NOTICE_HTML}
      </p>
    `,
  })

  return { subject, html }
}

export async function sendProjectGeneralNotificationEmail({
  clientEmail,
  clientName,
  projectTitle,
  shareUrl,
  readyVideos = [],
  readyAlbums = [],
  notes,
  isPasswordProtected = false,
  trackingToken,
}: {
  clientEmail: string
  clientName: string
  projectTitle: string
  shareUrl: string
  readyVideos?: Array<{ name: string; versionLabel: string }>
  readyAlbums?: Array<{ name: string; photoCount: number }>
  notes?: string | null
  isPasswordProtected?: boolean
  trackingToken?: string
}) {
  const { subject, html } = await renderProjectGeneralNotificationEmail({
    clientName,
    projectTitle,
    shareUrl,
    readyVideos,
    readyAlbums,
    notes,
    isPasswordProtected,
    trackingToken,
  })

  return sendEmail({
    to: clientEmail,
    subject,
    html,
  })
}

/**
 * Email template: Send password in separate email for security
 */
export async function renderPasswordEmail({
  clientName,
  projectTitle,
  password,
  branding,
}: {
  clientName: string
  projectTitle: string
  password: string
  branding?: EmailBrandingOverrides
}): Promise<RenderedEmail> {
  const resolved = await resolveEmailBranding(branding)

  const subject = `Access Password: ${escapeHtml(projectTitle)}`

  const headerGradient = EMAIL_THEME.headerBackground
  const cardStyle = emailCardStyle({ borderRadiusPx: 10, paddingPx: 14, marginBottomPx: 12 })
  const cardTitleStyle = 'font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:' + EMAIL_THEME.textMuted + '; margin-bottom:6px;'

  const html = renderEmailShell({
    companyName: resolved.companyName,
    companyLogoUrl: resolved.companyLogoUrl,
    headerGradient,
    title: 'Project Password',
    subtitle: projectTitle,
    trackingPixelsEnabled: resolved.trackingPixelsEnabled,
    appDomain: resolved.appDomain,
    bodyContent: `
      <p style="margin:0 0 16px; font-size:15px; color:#1f2937; line-height:1.6;">
        Hi <strong>${escapeHtml(clientName)}</strong>,
      </p>
      <p style="margin:0 0 16px; font-size:15px; color:#374151; line-height:1.6;">
        Use this password to access your project.  You should have received a link to the project in a separate email.
      </p>
      <div style="${cardStyle}">
        <div style="${cardTitleStyle}">Project</div>
        <div style="font-size:16px; font-weight:700; color:${EMAIL_THEME.text};">${escapeHtml(projectTitle)}</div>
      </div>
      <div style="${emailCardStyle({ borderRadiusPx: 12, paddingPx: 16, marginBottomPx: 16 })}; text-align:center;">
        <div style="font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:${EMAIL_THEME.textMuted}; font-weight:700; margin-bottom:8px;">Password</div>
        <div style="display:inline-block; padding:10px 14px; border-radius:8px; border:1px dashed ${EMAIL_THEME.accent}; font-family:'SFMono-Regular', Menlo, Consolas, monospace; font-size:18px; color:${EMAIL_THEME.text}; letter-spacing:1px; word-break:break-all;">
          ${escapeHtml(password)}
        </div>
      </div>
      <p style="font-size:13px; color:${EMAIL_THEME.text}; padding:0; margin:0;">
        Keep this password confidential. For security reasons, do not forward this email.
      </p>
    `,
  })

  return { subject, html }
}

export async function sendPasswordEmail({
  clientEmail,
  clientName,
  projectTitle,
  password,
}: {
  clientEmail: string
  clientName: string
  projectTitle: string
  password: string
}) {
  const { subject, html } = await renderPasswordEmail({
    clientName,
    projectTitle,
    password,
  })

  return sendEmail({
    to: clientEmail,
    subject,
    html,
  })
}

/**
 * Test SMTP connection and send a test email
 */
export async function testEmailConnection(testEmail: string, customConfig?: any) {
  try {
    // Use custom config for SMTP transport, but load DB settings for branding defaults.
    const dbSettings = await getEmailSettings()
    const settings = customConfig || dbSettings
    const transporter = await createTransporter(customConfig)

    // Verify connection
    await transporter.verify()

    // Send test email
    const html = renderEmailShell({
      companyName: settings.companyName || 'ViTransfer',
      companyLogoUrl: buildCompanyLogoUrl({
        appDomain: settings.appDomain || dbSettings.appDomain,
        companyLogoMode: settings.companyLogoMode || dbSettings.companyLogoMode,
        companyLogoPath: dbSettings.companyLogoPath,
        companyLogoUrl: settings.companyLogoUrl || dbSettings.companyLogoUrl,
        updatedAt: dbSettings.updatedAt,
      }),
      headerGradient: EMAIL_THEME.headerBackground,
      title: 'SMTP Test Succeeded',
      subtitle: 'Email sending is working',
      bodyContent: `
        <p style="font-size:15px; color:#1f2937; line-height:1.6; margin:0 0 12px;">
          Your SMTP configuration is working. Details below for your records.
        </p>
        <div style="${emailCardStyle({ borderRadiusPx: 10, paddingPx: 14, marginBottomPx: 0 })}">
          <div style="font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:${EMAIL_THEME.textMuted}; margin-bottom:6px;">Connection details</div>
          <div style="font-size:14px; color:#0f172a; line-height:1.6;">
            <div><strong>Server:</strong> ${settings.smtpServer}</div>
            <div><strong>Port:</strong> ${settings.smtpPort}</div>
            <div><strong>Security:</strong> ${settings.smtpSecure || 'STARTTLS'}</div>
            <div><strong>From:</strong> ${settings.smtpFromAddress}</div>
          </div>
        </div>
      `,
    })

    // Send directly with transporter if custom config, otherwise use sendEmail
    if (customConfig) {
      await transporter.sendMail({
        from: settings.smtpFromAddress,
        to: testEmail,
        subject: 'Test Email - SMTP Configuration Working',
        html,
      })
    } else {
      await sendEmail({
        to: testEmail,
        subject: 'Test Email - SMTP Configuration Working',
        html,
      })
    }

    return { success: true, message: 'Test email sent successfully!' }
  } catch (error) {
    console.error('Email test failed:', error)
    throw error
  }
}
