export type ProjectStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'REVIEWED'
  | 'ON_HOLD'
  | 'SHARE_ONLY'
  | 'APPROVED'
  | 'CLOSED'

export const PROJECT_STATUS_OPTIONS: Array<{ value: ProjectStatus; label: string }> = [
  { value: 'NOT_STARTED', label: 'Not Started' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'IN_REVIEW', label: 'In Review' },
  { value: 'REVIEWED', label: 'Reviewed' },
  { value: 'SHARE_ONLY', label: 'Share Only' },
  { value: 'ON_HOLD', label: 'On Hold' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'CLOSED', label: 'Closed' },
]

export function projectStatusLabel(status: string): string {
  const match = PROJECT_STATUS_OPTIONS.find((s) => s.value === status)
  return match?.label ?? status.replaceAll('_', ' ')
}

export function projectStatusBadgeClass(status: string): string {
  switch (status) {
    case 'REVIEWED':
      return 'bg-emerald-200 text-emerald-800 border-2 border-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-400/40'
    case 'APPROVED':
      return 'bg-success text-success-visible border-2 border-success-visible dark:bg-success/20 dark:text-success dark:border-success/40'
    case 'SHARE_ONLY':
      return 'bg-info text-info-visible border-2 border-info-visible dark:bg-info/20 dark:text-info dark:border-info/40'
    case 'ON_HOLD':
      return 'bg-warning text-warning-visible border-2 border-warning-visible dark:bg-warning/20 dark:text-warning dark:border-warning/40'
    case 'IN_REVIEW':
      return 'bg-blue-600 text-blue-50 border-2 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-400/40'
    case 'IN_PROGRESS':
      return 'bg-violet-800 text-violet-100 border-2 border-violet-200 dark:bg-violet-500/20 dark:text-violet-300 dark:border-violet-400/40'
    case 'NOT_STARTED':
      return 'bg-pending text-pending-visible border-2 border-pending-visible dark:bg-pending/20 dark:text-pending dark:border-pending/40'
    case 'CLOSED':
      return 'bg-muted text-muted-foreground border-2 border-muted-foreground'
    default:
      return 'bg-muted text-muted-foreground border border-border'
  }
}

export function projectStatusDotClass(status: string): string {
  switch (status) {
    case 'REVIEWED':
      return 'text-emerald-700 dark:text-emerald-300'
    case 'APPROVED':
      return 'text-success'
    case 'SHARE_ONLY':
      return 'text-info'
    case 'ON_HOLD':
      return 'text-warning'
    case 'IN_REVIEW':
      return 'text-blue-600 dark:text-blue-400'
    case 'IN_PROGRESS':
      return 'text-violet-600 dark:text-violet-400'
    case 'NOT_STARTED':
      return 'text-pending-visible dark:text-pending'
    case 'CLOSED':
      return 'text-muted-foreground'
    default:
      return 'text-muted-foreground'
  }
}

export function projectStatusSortPriority(status: string): number {
  switch (status) {
    case 'NOT_STARTED':
      return 0
    case 'IN_PROGRESS':
      return 1
    case 'IN_REVIEW':
      return 2
    case 'REVIEWED':
      return 3
    case 'SHARE_ONLY':
      return 4
    case 'ON_HOLD':
      return 5
    case 'APPROVED':
      return 6
    case 'CLOSED':
      return 7
    default:
      return 99
  }
}
