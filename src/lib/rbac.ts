import type { ProjectStatus } from '@/lib/project-status'

export type MenuKey = 'projects' | 'sharePage' | 'clients' | 'sales' | 'settings' | 'users' | 'security' | 'analytics'

export type ActionKey =
  | 'projectsPhotoVideoUploads'
  | 'projectsFullControl'
  | 'accessSharePage'
  | 'manageSharePageComments'
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

const ALL_MENUS: MenuKey[] = ['projects', 'sharePage', 'clients', 'sales', 'settings', 'users', 'security', 'analytics']
const ALL_ACTIONS: ActionKey[] = [
  'projectsPhotoVideoUploads',
  'projectsFullControl',
  'accessSharePage',
  'manageSharePageComments',
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
  // Note: the app now treats most areas as all-or-nothing via menu access.
  // These fallbacks are retained for backwards-compatibility with legacy stored JSON.
  projects: ['manageProjectAlbums'],
  sharePage: [],
  clients: ['manageClients', 'manageClientFiles'],
  sales: [],
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
  const projectsEnabled = permissions.menuVisibility.projects === true
  const sharePageEnabled = permissions.menuVisibility.sharePage === true

  const legacyFullControl =
    permissions.actions.accessProjectSettings === true ||
    permissions.actions.changeProjectSettings === true ||
    permissions.actions.sendNotificationsToRecipients === true ||
    permissions.actions.changeProjectStatuses === true ||
    permissions.actions.deleteProjects === true

  const projectsFullControl =
    projectsEnabled && (permissions.actions.projectsFullControl === true || legacyFullControl)

  const legacyPhotoVideo =
    permissions.actions.uploadVideosOnProjects === true ||
    permissions.actions.manageProjectAlbums === true

  const projectsPhotoVideo =
    projectsEnabled &&
    (projectsFullControl || permissions.actions.projectsPhotoVideoUploads === true || legacyPhotoVideo)

  switch (action) {
    // Share Page (new)
    case 'accessSharePage':
      return sharePageEnabled
    case 'manageSharePageComments':
      return sharePageEnabled && permissions.actions.manageSharePageComments === true

    // Projects: simplified policy
    case 'projectsFullControl':
      return projectsFullControl
    case 'projectsPhotoVideoUploads':
      return projectsPhotoVideo

    case 'uploadFilesToProjectInternal':
    case 'makeCommentsOnProjects':
      // Base Projects access
      return projectsEnabled

    case 'uploadVideosOnProjects':
    case 'manageProjectAlbums':
      return projectsPhotoVideo

    case 'accessProjectSettings':
    case 'changeProjectSettings':
    case 'sendNotificationsToRecipients':
    case 'changeProjectStatuses':
    case 'deleteProjects':
      return projectsFullControl

    // All-or-nothing areas
    case 'manageClients':
    case 'manageClientFiles':
      return permissions.menuVisibility.clients === true

    case 'changeSettings':
    case 'sendTestEmail':
      return permissions.menuVisibility.settings === true

    case 'manageUsers':
    case 'manageRoles':
      return permissions.menuVisibility.users === true

    case 'viewSecurityEvents':
    case 'manageSecurityEvents':
    case 'viewSecurityBlocklists':
    case 'manageSecurityBlocklists':
    case 'viewSecurityRateLimits':
    case 'manageSecurityRateLimits':
      return permissions.menuVisibility.security === true

    case 'viewAnalytics':
      return permissions.menuVisibility.analytics === true

    default:
      return permissions.actions[action] === true
  }
}

export function adminAllPermissions(): RolePermissions {
  const p = defaultRolePermissions()
  for (const key of ALL_MENUS) p.menuVisibility[key] = true
  for (const key of ALL_ACTIONS) p.actions[key] = true
  p.projectVisibility.statuses = ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'REVIEWED', 'SHARE_ONLY', 'ON_HOLD', 'APPROVED', 'CLOSED']
  return p
}
