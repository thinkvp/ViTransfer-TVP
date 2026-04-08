import { prisma } from '@/lib/db'
import { sendBrowserPushToEligibleUsers } from '@/lib/admin-web-push'

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
    | 'RATE_LIMIT_ALERT'
    | 'QUICKBOOKS_DAILY_PULL_FAILURE'
    | 'ORPHAN_PROJECT_FILES_SCAN'
    | 'DROPBOX_STORAGE_INCONSISTENCY'
  projectId?: string
  projectName?: string
  kanbanCardId?: string
  title: string
  message: string
  details?: Record<string, any>
}

/**
 * Send a push notification via browser push and log it for the in-app notification bell.
 * The master toggle and per-event toggles gate all delivery.
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

    // Check master toggle — when disabled, still log for the notification bell but skip push delivery.
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
              enabled: false,
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
      // Still log for the bell, but skip push delivery.
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

    // Log for the notification bell.
    await prisma.pushNotificationLog.create({
      data: {
        type: payload.type,
        projectId: payload.projectId,
        success: true,
        statusCode: null,
        message: 'Notification sent',
        details: {
          ...baseDetails,
          __delivery: {
            attempted: true,
            enabled: true,
          },
        },
      },
    })

    return { success: true }
  } catch (error) {
    console.error('[PUSH_NOTIFICATION] Error sending notification:', error)
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
