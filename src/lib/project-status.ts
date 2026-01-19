export type ProjectStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'ON_HOLD'
  | 'SHARE_ONLY'
  | 'APPROVED'
  | 'CLOSED'

export const PROJECT_STATUS_OPTIONS: Array<{ value: ProjectStatus; label: string }> = [
  { value: 'NOT_STARTED', label: 'Not Started' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'IN_REVIEW', label: 'In Review' },
  { value: 'ON_HOLD', label: 'On Hold' },
  { value: 'SHARE_ONLY', label: 'Share Only' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'CLOSED', label: 'Closed' },
]

export function projectStatusLabel(status: string): string {
  const match = PROJECT_STATUS_OPTIONS.find((s) => s.value === status)
  return match?.label ?? status.replaceAll('_', ' ')
}

export function projectStatusBadgeClass(status: string): string {
  switch (status) {
    case 'APPROVED':
      return 'bg-success text-success-visible border-2 border-success-visible dark:bg-success/20 dark:text-success dark:border-success/40'
    case 'SHARE_ONLY':
      return 'bg-info text-info-visible border-2 border-info-visible dark:bg-info/20 dark:text-info dark:border-info/40'
    case 'ON_HOLD':
      return 'bg-warning text-warning-visible border-2 border-warning-visible dark:bg-warning/20 dark:text-warning dark:border-warning/40'
    case 'IN_REVIEW':
      return 'bg-primary text-primary-visible border-2 border-primary-visible dark:bg-primary/20 dark:text-primary dark:border-primary/40'
    case 'IN_PROGRESS':
      return 'bg-violet-800 text-violet-100 border-2 border-violet-200 dark:bg-violet-500/20 dark:text-violet-300 dark:border-violet-400/40'
    case 'NOT_STARTED':
      return 'bg-pending text-pending-visible border-2 border-pending-visible dark:bg-pending/20 dark:text-pending dark:border-pending/40'
    case 'CLOSED':
      return 'bg-muted text-muted-foreground border border-border'
    default:
      return 'bg-muted text-muted-foreground border border-border'
  }
}

export function projectStatusDotClass(status: string): string {
  switch (status) {
    case 'APPROVED':
      return 'text-success'
    case 'SHARE_ONLY':
      return 'text-info'
    case 'ON_HOLD':
      return 'text-warning'
    case 'IN_REVIEW':
      return 'text-primary'
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
    case 'ON_HOLD':
      return 2
    case 'SHARE_ONLY':
      return 3
    case 'APPROVED':
      return 4
    case 'CLOSED':
      return 5
    default:
      return 99
  }
}
