export type ProjectStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'REVIEWED'
  | 'ON_HOLD'
  | 'APPROVED'
  | 'CLOSED'

export const PROJECT_STATUS_OPTIONS: Array<{ value: ProjectStatus; label: string }> = [
  { value: 'NOT_STARTED', label: 'Not Started' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'IN_REVIEW', label: 'In Review' },
  { value: 'REVIEWED', label: 'Reviewed' },
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
      return 'bg-emerald-500/20 text-emerald-300'
    case 'APPROVED':
      return 'bg-green-500/20 text-green-300'
    case 'ON_HOLD':
      return 'bg-warning/20 text-warning'
    case 'IN_REVIEW':
      return 'bg-blue-500/20 text-blue-300'
    case 'IN_PROGRESS':
      return 'bg-violet-500/20 text-violet-300'
    case 'NOT_STARTED':
      return 'bg-pending/20 text-pending'
    case 'CLOSED':
      return 'bg-muted text-muted-foreground'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

export function projectStatusDotClass(status: string): string {
  switch (status) {
    case 'REVIEWED':
      return 'text-emerald-300'
    case 'APPROVED':
      return 'text-success'
    case 'ON_HOLD':
      return 'text-warning'
    case 'IN_REVIEW':
      return 'text-blue-400'
    case 'IN_PROGRESS':
      return 'text-violet-400'
    case 'NOT_STARTED':
      return 'text-pending'
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
    case 'ON_HOLD':
      return 4
    case 'APPROVED':
      return 5
    case 'CLOSED':
      return 6
    default:
      return 99
  }
}
