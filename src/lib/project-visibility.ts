/**
 * Centralized project visibility filtering for admin API routes.
 *
 * Several admin routes repeat the same pattern:
 *   1. Get allowed statuses from the user's RBAC permissions
 *   2. If system admin, skip assignment check; otherwise require assignment
 *   3. Return a Prisma-compatible `where` clause, or null if no access
 *
 * This helper ensures consistent visibility enforcement across:
 *   - GET /api/projects
 *   - GET /api/admin/share-projects
 *   - GET /api/analytics
 *   - GET /api/projects/key-dates
 */

import type { Prisma, ProjectStatus } from '@prisma/client'
import { getUserPermissions } from '@/lib/rbac-api'
import type { AuthUser } from '@/lib/auth'

export interface ProjectVisibilityResult {
  /** Prisma where clause to filter projects, or null if the user has no project access. */
  where: Prisma.ProjectWhereInput | null
  /** Allowed status values (empty array = no access). */
  statuses: string[]
  /** Whether the user is a system admin (bypasses assignment check). */
  isSystemAdmin: boolean
}

/**
 * Resolve the Prisma where clause for listing projects visible to a user.
 *
 * @param user  - The authenticated AuthUser (from requireApiUser / requireApiAuth).
 * @returns A ProjectVisibilityResult with the `where` clause or null if no access.
 */
export function resolveVisibleProjectWhere(user: AuthUser): ProjectVisibilityResult {
  const permissions = getUserPermissions(user)
  const statuses = (permissions.projectVisibility?.statuses ?? []) as string[]
  const isSystemAdmin = user.appRoleIsSystemAdmin === true

  if (statuses.length === 0) {
    return { where: null, statuses: [], isSystemAdmin }
  }

  const where: Prisma.ProjectWhereInput = {
    status: { in: statuses as ProjectStatus[] },
    ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: user.id } } }),
  }

  return { where, statuses, isSystemAdmin }
}
