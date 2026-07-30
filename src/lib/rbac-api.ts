import { NextRequest, NextResponse } from 'next/server'
import {
  canDoAction,
  canSeeMenu,
  isProjectStatusVisible,
  normalizeRolePermissions,
  type ActionKey,
  type MenuKey,
  type RolePermissions,
} from '@/lib/rbac'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'

export function getUserPermissions(user: any): RolePermissions {
  return normalizeRolePermissions(user?.permissions)
}

/**
 * Fire-and-forget action-denied logging at INFO level.
 * Menu access denials are not logged — they are expected RBAC enforcement, not
 * security events. Only action denials (more specific, operation-level gates)
 * are recorded, at INFO severity, for audit purposes.
 */
function logActionDenied(user: any, resource: string, request?: NextRequest) {
  logSecurityEvent({
    type: 'PERMISSION_DENIED',
    severity: 'INFO',
    ipAddress: request ? getClientIpAddress(request) : undefined,
    details: {
      userId: user?.id,
      email: user?.email,
      role: user?.appRoleName || user?.role,
      resource,
    },
  }).catch(() => {})
}

// Friendlier denial messages for actions where the user can see the area but not modify it.
const READ_ONLY_MESSAGE = 'Your account has read-only access. Request permission from an administrator to be able to make changes.'
const ACTION_DENIED_MESSAGES: Partial<Record<ActionKey, string>> = {
  manageSales: READ_ONLY_MESSAGE,
  manageAccounting: READ_ONLY_MESSAGE,
}

export function requireMenuAccess(user: any, menu: MenuKey, request?: NextRequest): Response | null {
  const permissions = getUserPermissions(user)
  if (!canSeeMenu(permissions, menu)) {
    // Menu access denial is expected RBAC behaviour — not logged as a security event.
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export function requireActionAccess(user: any, action: ActionKey, request?: NextRequest): Response | null {
  const permissions = getUserPermissions(user)
  if (!canDoAction(permissions, action)) {
    logActionDenied(user, `action:${action}`, request)
    return NextResponse.json({ error: ACTION_DENIED_MESSAGES[action] ?? 'Forbidden' }, { status: 403 })
  }
  return null
}

export function requireAnyActionAccess(user: any, actions: ActionKey[], request?: NextRequest): Response | null {
  const permissions = getUserPermissions(user)
  const allowed = actions.some((a) => canDoAction(permissions, a))
  if (!allowed) {
    logActionDenied(user, `actions:${actions.join(',')}`, request)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export function isVisibleProjectStatusForUser(user: any, status: string): boolean {
  const permissions = getUserPermissions(user)
  return isProjectStatusVisible(permissions, status)
}
