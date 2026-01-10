import type { ProjectStatus } from '@/lib/project-status'

export type MenuKey = 'projects' | 'clients' | 'settings' | 'users' | 'security' | 'analytics'

export type ActionKey =
  | 'manageClients'
  | 'manageClientFiles'
  | 'changeSettings'
  | 'sendTestEmail'
  | 'manageUsers'
  | 'manageRoles'
  | 'viewSecurityEvents'
  | 'manageSecurityEvents'
  | 'viewSecurityBlocklists'
  | 'manageSecurityBlocklists'
  | 'viewSecurityRateLimits'
  | 'manageSecurityRateLimits'
  | 'manageProjectAlbums'
  | 'accessProjectSettings'
  | 'changeProjectSettings'
  | 'uploadFilesToProjectInternal'
  | 'uploadVideosOnProjects'
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

const ALL_MENUS: MenuKey[] = ['projects', 'clients', 'settings', 'users', 'security', 'analytics']
const ALL_ACTIONS: ActionKey[] = [
  'manageClients',
  'manageClientFiles',
  'changeSettings',
  'sendTestEmail',
  'manageUsers',
  'manageRoles',
  'viewSecurityEvents',
  'manageSecurityEvents',
  'viewSecurityBlocklists',
  'manageSecurityBlocklists',
  'viewSecurityRateLimits',
  'manageSecurityRateLimits',
  'manageProjectAlbums',
  'accessProjectSettings',
  'changeProjectSettings',
  'uploadFilesToProjectInternal',
  'uploadVideosOnProjects',
  'sendNotificationsToRecipients',
  'makeCommentsOnProjects',
  'changeProjectStatuses',
  'deleteProjects',
  'viewAnalytics',
]

// Backwards-compatibility: historically, some areas were effectively gated by menu access only.
// When migrating to more granular per-area actions, default a subset of actions to true
// when the corresponding menu is enabled *unless* the action is explicitly present in stored JSON.
const FALLBACK_ACTIONS_BY_MENU: Record<MenuKey, ActionKey[]> = {
  projects: ['manageProjectAlbums'],
  clients: ['manageClients', 'manageClientFiles'],
  settings: ['changeSettings', 'sendTestEmail'],
  users: ['manageUsers', 'manageRoles'],
  security: ['viewSecurityEvents', 'manageSecurityEvents', 'viewSecurityBlocklists', 'manageSecurityBlocklists', 'viewSecurityRateLimits', 'manageSecurityRateLimits'],
  analytics: [],
}

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
    const hasKey = Object.prototype.hasOwnProperty.call(actionsRaw, key)
    if (hasKey) {
      base.actions[key] = actionsRaw[key] === true
    } else {
      base.actions[key] = false
    }
  }

  // Apply fallback defaults for legacy roles
  for (const menuKey of ALL_MENUS) {
    if (base.menuVisibility[menuKey] !== true) continue
    const fallbackActions = FALLBACK_ACTIONS_BY_MENU[menuKey] || []
    for (const actionKey of fallbackActions) {
      const hasActionKey = Object.prototype.hasOwnProperty.call(actionsRaw, actionKey)
      if (!hasActionKey) {
        base.actions[actionKey] = true
      }
    }
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
