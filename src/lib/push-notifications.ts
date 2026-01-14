import { prisma } from '@/lib/db'

export interface PushNotificationPayload {
  type:
    | 'UNAUTHORIZED_OTP'
    | 'FAILED_LOGIN'
    | 'SUCCESSFUL_ADMIN_LOGIN'
    | 'FAILED_SHARE_PASSWORD'
    | 'SHARE_ACCESS'
    | 'CLIENT_COMMENT'
    | 'VIDEO_APPROVAL'
    | 'SALES_QUOTE_VIEWED'
    | 'SALES_QUOTE_ACCEPTED'
    | 'SALES_INVOICE_VIEWED'
  projectId?: string
  projectName?: string
  title: string
  message: string
  details?: Record<string, any>
}

/**
 * Send a push notification via the configured service (Gotify, etc.)
 */
export async function sendPushNotification(payload: PushNotificationPayload): Promise<{ success: boolean; statusCode?: number; message?: string }> {
  try {
    // Get push notification settings
    const settings = await prisma.pushNotificationSettings.findUnique({
      where: { id: 'default' },
    })

    // If not enabled or not configured, skip
    if (!settings?.enabled || !settings.webhookUrl || !settings.provider) {
      return { success: false, message: 'Push notifications not configured' }
    }

    // Check if this event type is enabled
    const eventToggleMap: Record<string, keyof Omit<typeof settings, 'id' | 'enabled' | 'provider' | 'webhookUrl' | 'title' | 'createdAt' | 'updatedAt'>> = {
      'UNAUTHORIZED_OTP': 'notifyUnauthorizedOTP',
      'FAILED_LOGIN': 'notifyFailedAdminLogin',
      'SUCCESSFUL_ADMIN_LOGIN': 'notifySuccessfulAdminLogin',
      'FAILED_SHARE_PASSWORD': 'notifyFailedSharePasswordAttempt',
      'SHARE_ACCESS': 'notifySuccessfulShareAccess',
      'CLIENT_COMMENT': 'notifyClientComments',
      'VIDEO_APPROVAL': 'notifyVideoApproval',
      'SALES_QUOTE_VIEWED': 'notifySalesQuoteViewed',
      'SALES_QUOTE_ACCEPTED': 'notifySalesQuoteAccepted',
      'SALES_INVOICE_VIEWED': 'notifySalesInvoiceViewed',
    }

    const toggleKey = eventToggleMap[payload.type]
    if (toggleKey && !settings[toggleKey]) {
      return { success: false, message: 'This notification type is disabled' }
    }

    // Build notification based on provider
    const result = await sendToProvider(settings.provider, settings.webhookUrl, payload, settings.title)

    // Log the notification attempt
    await prisma.pushNotificationLog.create({
      data: {
        type: payload.type,
        projectId: payload.projectId,
        success: result.success,
        statusCode: result.statusCode,
        message: result.message,
        details: payload.details,
      },
    })

    return result
  } catch (error) {
    console.error('[PUSH_NOTIFICATION] Error sending notification:', error)
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Send notification to the configured provider
 */
async function sendToProvider(
  provider: string,
  webhookUrl: string,
  payload: PushNotificationPayload,
  titlePrefix?: string | null
): Promise<{ success: boolean; statusCode?: number; message?: string }> {
  if (provider === 'GOTIFY') {
    return sendToGotify(webhookUrl, payload, titlePrefix)
  }

  return { success: false, message: `Unknown provider: ${provider}` }
}

/**
 * Send notification to Gotify
 * See: https://gotify.net/api-docs
 */
async function sendToGotify(
  webhookUrl: string,
  payload: PushNotificationPayload,
  titlePrefix?: string | null
): Promise<{ success: boolean; statusCode?: number; message?: string }> {
  try {
    // Format the title with optional prefix
    let title = payload.title
    if (titlePrefix) {
      title = `[${titlePrefix}] ${title}`
    }

    // Build the message with details
    let message = payload.message
    if (payload.details && Object.keys(payload.details).length > 0) {
      const detailLines = Object.entries(payload.details)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      message += '\n\n' + detailLines.join('\n')
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        message,
        priority: getPriorityForType(payload.type),
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return {
        success: false,
        statusCode: response.status,
        message: `Gotify API returned ${response.status}: ${errorText}`,
      }
    }

    return { success: true, statusCode: response.status }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to send to Gotify',
    }
  }
}

/**
 * Get Gotify priority based on notification type
 * Priority: higher number = more important
 */
function getPriorityForType(type: string): number {
  switch (type) {
    case 'FAILED_LOGIN':
      return 10 // Critical
    case 'FAILED_SHARE_PASSWORD':
      return 7 // High
    case 'UNAUTHORIZED_OTP':
      return 8 // High
    case 'VIDEO_APPROVAL':
      return 7 // High
    case 'CLIENT_COMMENT':
      return 5 // Medium
    case 'SUCCESSFUL_ADMIN_LOGIN':
      return 3 // Low
    case 'SHARE_ACCESS':
      return 3 // Low
    case 'SALES_QUOTE_VIEWED':
      return 3 // Low
    case 'SALES_QUOTE_ACCEPTED':
      return 6 // Medium-High
    case 'SALES_INVOICE_VIEWED':
      return 3 // Low
    default:
      return 5
  }
}
