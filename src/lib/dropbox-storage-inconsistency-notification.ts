export const DROPBOX_STORAGE_INCONSISTENCY_NOTIFICATION_TYPE = 'DROPBOX_STORAGE_INCONSISTENCY'
export const ORPHAN_PROJECT_FILES_SCAN_NOTIFICATION_TYPE = 'ORPHAN_PROJECT_FILES_SCAN'
export const QUICKBOOKS_DAILY_PULL_FAILURE_NOTIFICATION_TYPE = 'QUICKBOOKS_DAILY_PULL_FAILURE'

export const PINNED_SYSTEM_NOTIFICATION_TYPES = [
  DROPBOX_STORAGE_INCONSISTENCY_NOTIFICATION_TYPE,
  ORPHAN_PROJECT_FILES_SCAN_NOTIFICATION_TYPE,
  QUICKBOOKS_DAILY_PULL_FAILURE_NOTIFICATION_TYPE,
] as const

type PinnedSystemNotificationControls = {
  clearable?: boolean
  pinned?: boolean
  manualClearRequired?: boolean
}

type PinnedSystemNotificationDetails = {
  __controls?: PinnedSystemNotificationControls
  [key: string]: unknown
}

export function isPinnedSystemNotificationType(type: string): boolean {
  return (PINNED_SYSTEM_NOTIFICATION_TYPES as readonly string[]).includes(type)
}

export function isPinnedSystemNotificationDetails(details: unknown): details is PinnedSystemNotificationDetails {
  if (!details || typeof details !== 'object') return false
  const d = details as Record<string, unknown>
  if (!d.__controls || typeof d.__controls !== 'object') return false
  return (d.__controls as PinnedSystemNotificationControls).pinned === true
}

export function isClearablePinnedNotificationDetails(details: unknown): boolean {
  if (!isPinnedSystemNotificationDetails(details)) return false
  const controls = details.__controls as PinnedSystemNotificationControls
  return controls?.clearable === true && controls?.manualClearRequired === true
}
