import { prisma } from '@/lib/db'
import { sendBrowserPushToEligibleUsers } from '@/lib/admin-web-push'
import { buildAdminWebPushNotification } from '@/lib/admin-web-push-templates'

export interface PushNotificationPayload {
  type:
    | 'UNAUTHORIZED_OTP'
    | 'FAILED_LOGIN'
    | 'SUCCESSFUL_ADMIN_LOGIN'
    | 'FAILED_SHARE_PASSWORD'
    | 'SHARE_ACCESS'
    | 'GUEST_VIDEO_LINK_ACCESS'
    | 'CLIENT_COMMENT'
    | 'ADMIN_SHARE_COMMENT'
    | 'VIDEO_APPROVAL'
    | 'INTERNAL_COMMENT'
    | 'TASK_COMMENT'
    | 'TASK_USER_ASSIGNED'
    | 'PROJECT_USER_ASSIGNED'
    | 'SALES_QUOTE_VIEWED'
    | 'SALES_QUOTE_ACCEPTED'
    | 'SALES_INVOICE_VIEWED'
    | 'SALES_INVOICE_PAID'
    | 'SALES_REMINDER_INVOICE_OVERDUE'
    | 'SALES_REMINDER_QUOTE_EXPIRING'
    | 'PASSWORD_RESET_REQUESTED'
    | 'PASSWORD_RESET_SUCCESS'
  projectId?: string
  projectName?: string
  kanbanCardId?: string
  title: string
  message: string
  details?: Record<string, any>
}

/**
 * Send a push notification via all configured channels (Browser Push, Gotify/Ntfy).
 * The master toggle and per-event toggles apply to ALL channels.
 */
export async function sendPushNotification(payload: PushNotificationPayload): Promise<{ success: boolean; statusCode?: number; message?: string }> {
  try {
    // Get push notification settings
    const settings = await prisma.pushNotificationSettings.findUnique({
      where: { id: 'default' },
    })

    const baseDetails = {
      ...(payload.details ?? {}),
      __payload: {
        title: payload.title,
        message: payload.message,
        projectName: payload.projectName,
      },
    }

    // Check master toggle — when disabled, still log for the notification bell but skip all push delivery.
    if (!settings?.enabled) {
      await prisma.pushNotificationLog.create({
        data: {
          type: payload.type,
          projectId: payload.projectId,
          success: true,
          statusCode: null,
          message: 'Push delivery skipped (notifications disabled)',
          details: {
            ...baseDetails,
            __delivery: {
              attempted: false,
              provider: settings?.provider ?? null,
              enabled: false,
              webhookConfigured: Boolean(settings?.webhookUrl),
            },
          },
        },
      })
      return { success: true, message: 'Push delivery skipped (notifications disabled)' }
    }

    // Check if this event type is enabled
    type ToggleKey =
      | 'notifyUnauthorizedOTP'
      | 'notifyFailedAdminLogin'
      | 'notifySuccessfulAdminLogin'
      | 'notifyFailedSharePasswordAttempt'
      | 'notifySuccessfulShareAccess'
      | 'notifyGuestVideoLinkAccess'
      | 'notifyClientComments'
      | 'notifyInternalComments'
      | 'notifyTaskComments'
      | 'notifyVideoApproval'
      | 'notifyUserAssignments'
      | 'notifySalesQuoteViewed'
      | 'notifySalesQuoteAccepted'
      | 'notifySalesInvoiceViewed'
      | 'notifySalesInvoicePaid'
      | 'notifySalesReminders'
      | 'notifyPasswordResetRequested'
      | 'notifyPasswordResetSuccess'

    const eventToggleMap: Record<string, ToggleKey> = {
      'UNAUTHORIZED_OTP': 'notifyUnauthorizedOTP',
      'FAILED_LOGIN': 'notifyFailedAdminLogin',
      'SUCCESSFUL_ADMIN_LOGIN': 'notifySuccessfulAdminLogin',
      'FAILED_SHARE_PASSWORD': 'notifyFailedSharePasswordAttempt',
      'SHARE_ACCESS': 'notifySuccessfulShareAccess',
      'GUEST_VIDEO_LINK_ACCESS': 'notifyGuestVideoLinkAccess',
      'CLIENT_COMMENT': 'notifyClientComments',
      'ADMIN_SHARE_COMMENT': 'notifyClientComments',
      'INTERNAL_COMMENT': 'notifyInternalComments',
      'TASK_COMMENT': 'notifyTaskComments',
      'VIDEO_APPROVAL': 'notifyVideoApproval',
      'PROJECT_USER_ASSIGNED': 'notifyUserAssignments',
      'TASK_USER_ASSIGNED': 'notifyUserAssignments',
      'SALES_QUOTE_VIEWED': 'notifySalesQuoteViewed',
      'SALES_QUOTE_ACCEPTED': 'notifySalesQuoteAccepted',
      'SALES_INVOICE_VIEWED': 'notifySalesInvoiceViewed',
      'SALES_INVOICE_PAID': 'notifySalesInvoicePaid',
      'SALES_REMINDER_INVOICE_OVERDUE': 'notifySalesReminders',
      'SALES_REMINDER_QUOTE_EXPIRING': 'notifySalesReminders',
      'PASSWORD_RESET_REQUESTED': 'notifyPasswordResetRequested',
      'PASSWORD_RESET_SUCCESS': 'notifyPasswordResetSuccess',
    }

    const toggleKey = eventToggleMap[payload.type]
    if (settings && toggleKey && !(settings as any)[toggleKey]) {
      // Still log for the bell, but skip all push delivery.
      await prisma.pushNotificationLog.create({
        data: {
          type: payload.type,
          projectId: payload.projectId,
          success: true,
          statusCode: null,
          message: `Push delivery skipped (${payload.type} notifications disabled)`,
          details: {
            ...baseDetails,
            __delivery: {
              attempted: false,
              provider: settings.provider ?? null,
              enabled: true,
              eventDisabled: true,
            },
          },
        },
      })
      return { success: false, message: 'This notification type is disabled' }
    }

    // Send browser push (best-effort, fire-and-forget).
    sendBrowserPushToEligibleUsers(payload).catch((err: any) => {
      const code = typeof err?.code === 'string' ? err.code : ''
      if (code === 'P2021' || code === 'P2022') {
        console.warn('[WEB_PUSH] Web push tables/columns missing; run Prisma migrations.')
        return
      }
      console.warn('[WEB_PUSH] Failed to send browser push:', err?.message ?? err)
    })

    // If Gotify/Ntfy webhook is not configured, just log for the bell.
    if (!settings.webhookUrl || !settings.provider) {
      await prisma.pushNotificationLog.create({
        data: {
          type: payload.type,
          projectId: payload.projectId,
          success: true,
          statusCode: null,
          message: 'Webhook delivery skipped (no provider configured)',
          details: {
            ...baseDetails,
            __delivery: {
              attempted: false,
              provider: settings.provider ?? null,
              enabled: true,
              webhookConfigured: false,
            },
          },
        },
      })
      return { success: true, message: 'Webhook delivery skipped (no provider configured)' }
    }

    // Send to webhook provider (Gotify/Ntfy)
    const result = await sendToWebhook(settings.webhookUrl, payload)

    // Log the notification attempt
    await prisma.pushNotificationLog.create({
      data: {
        type: payload.type,
        projectId: payload.projectId,
        success: result.success,
        statusCode: result.statusCode,
        message: result.message,
        details: {
          ...baseDetails,
          __delivery: {
            attempted: true,
            provider: settings.provider,
            enabled: true,
            webhookConfigured: true,
          },
        },
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
 * Send notification to a webhook endpoint (Gotify or Ntfy).
 * Uses the same templates as Browser Push for consistent formatting.
 */
async function sendToWebhook(
  webhookUrl: string,
  payload: PushNotificationPayload,
): Promise<{ success: boolean; statusCode?: number; message?: string }> {
  try {
    // Use the same template as Browser Push for consistent notification content.
    const formatted = buildAdminWebPushNotification(payload)

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: formatted.title,
        message: formatted.body,
        priority: getPriorityForType(payload.type),
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return {
        success: false,
        statusCode: response.status,
        message: `Webhook returned ${response.status}: ${errorText}`,
      }
    }

    return { success: true, statusCode: response.status }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to send to webhook',
    }
  }
}

/**
 * Get priority based on notification type (used by Gotify/Ntfy webhook).
 * Priority: higher number = more important.
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
    case 'PASSWORD_RESET_SUCCESS':
      return 8 // High - security-relevant password change
    case 'PASSWORD_RESET_REQUESTED':
      return 5 // Medium - informational
    case 'CLIENT_COMMENT':
      return 5 // Medium
    case 'ADMIN_SHARE_COMMENT':
      return 3 // Low-Medium (collaboration signal)
    case 'SUCCESSFUL_ADMIN_LOGIN':
      return 3 // Low
    case 'SHARE_ACCESS':
      return 3 // Low
    case 'GUEST_VIDEO_LINK_ACCESS':
      return 3 // Low
    case 'SALES_QUOTE_VIEWED':
      return 3 // Low
    case 'SALES_QUOTE_ACCEPTED':
      return 6 // Medium-High
    case 'SALES_INVOICE_VIEWED':
      return 3 // Low
    case 'SALES_INVOICE_PAID':
      return 7 // High
    default:
      return 5
  }
}
