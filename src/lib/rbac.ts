import type { ProjectStatus } from '@/lib/project-status'

export type MenuKey = 'projects' | 'clients' | 'settings' | 'users' | 'integrations' | 'security' | 'analytics'

export type ActionKey =
  | 'accessProjectSettings'
  | 'changeProjectSettings'
  | 'sendNotificationsToRecipients'
  | 'makeCommentsOnProjects'
  | 'changeProjectStatuses'
  | 'deleteProjects'
  | 'viewAnalytics'

export interface RolePermissions {
  menuVisibility: Record<MenuKey, boolean>
  projectVisibility: {
    statuses: ProjectStatus[]
  }
  actions: Record<ActionKey, boolean>
}

const ALL_MENUS: MenuKey[] = ['projects', 'clients', 'settings', 'users', 'integrations', 'security', 'analytics']
const ALL_ACTIONS: ActionKey[] = [
  'accessProjectSettings',
  'changeProjectSettings',
  'sendNotificationsToRecipients',
  'makeCommentsOnProjects',
  'changeProjectStatuses',
  'deleteProjects',
  'viewAnalytics',
]

export function defaultRolePermissions(): RolePermissions {
  const menuVisibility = Object.fromEntries(ALL_MENUS.map((k) => [k, false])) as Record<MenuKey, boolean>
  const actions = Object.fromEntries(ALL_ACTIONS.map((k) => [k, false])) as Record<ActionKey, boolean>
  return { menuVisibility, projectVisibility: { statuses: [] }, actions }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeRolePermissions(raw: unknown): RolePermissions {
  const base = defaultRolePermissions()
  if (!isRecord(raw)) return base

  const menuVisibilityRaw = isRecord(raw.menuVisibility) ? raw.menuVisibility : {}
  for (const key of ALL_MENUS) {
    const v = menuVisibilityRaw[key]
    base.menuVisibility[key] = v === true
  }

  const projectVisibilityRaw = isRecord(raw.projectVisibility) ? raw.projectVisibility : {}
  const statusesRaw = Array.isArray(projectVisibilityRaw.statuses) ? projectVisibilityRaw.statuses : []
  base.projectVisibility.statuses = statusesRaw.filter((s): s is ProjectStatus => typeof s === 'string') as ProjectStatus[]

  const actionsRaw = isRecord(raw.actions) ? raw.actions : {}
  for (const key of ALL_ACTIONS) {
    const v = actionsRaw[key]
    base.actions[key] = v === true
  }

  return base
}

export function isProjectStatusVisible(permissions: RolePermissions, status: string): boolean {
  // If no statuses configured, default to none.
  return permissions.projectVisibility.statuses.includes(status as ProjectStatus)
}

export function canSeeMenu(permissions: RolePermissions, menu: MenuKey): boolean {
  return permissions.menuVisibility[menu] === true
}

export function canDoAction(permissions: RolePermissions, action: ActionKey): boolean {
  return permissions.actions[action] === true
}

export function adminAllPermissions(): RolePermissions {
  const p = defaultRolePermissions()
  for (const key of ALL_MENUS) p.menuVisibility[key] = true
  for (const key of ALL_ACTIONS) p.actions[key] = true
  p.projectVisibility.statuses = ['NOT_STARTED', 'IN_REVIEW', 'ON_HOLD', 'SHARE_ONLY', 'APPROVED', 'CLOSED']
  return p
}
