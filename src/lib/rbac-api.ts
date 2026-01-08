import { NextResponse } from 'next/server'
import {
  canDoAction,
  canSeeMenu,
  isProjectStatusVisible,
  normalizeRolePermissions,
  type ActionKey,
  type MenuKey,
  type RolePermissions,
} from '@/lib/rbac'

export function getUserPermissions(user: any): RolePermissions {
  return normalizeRolePermissions(user?.permissions)
}

export function requireMenuAccess(user: any, menu: MenuKey): Response | null {
  const permissions = getUserPermissions(user)
  if (!canSeeMenu(permissions, menu)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export function requireActionAccess(user: any, action: ActionKey): Response | null {
  const permissions = getUserPermissions(user)
  if (!canDoAction(permissions, action)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export function isVisibleProjectStatusForUser(user: any, status: string): boolean {
  const permissions = getUserPermissions(user)
  return isProjectStatusVisible(permissions, status)
}
