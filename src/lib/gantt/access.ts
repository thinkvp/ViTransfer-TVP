// Project-scoping helper for schedule API routes: 404s when the project does
// not exist, its status is hidden from the user's role, or the user is not
// assigned to it (non-system-admins). Same semantics as the key-dates routes.

import { prisma } from '@/lib/db'
import type { AuthUser } from '@/lib/auth'
import { isVisibleProjectStatusForUser } from '@/lib/rbac-api'

export async function assertProjectAccessOr404(projectId: string, auth: AuthUser) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, status: true, title: true, companyName: true, startDate: true },
  })
  if (!project) return null

  if (!isVisibleProjectStatusForUser(auth, project.status)) return null

  if (auth.appRoleIsSystemAdmin !== true) {
    const assignment = await prisma.projectUser.findUnique({
      where: {
        projectId_userId: {
          projectId: project.id,
          userId: auth.id,
        },
      },
      select: { projectId: true },
    })
    if (!assignment) return null
  }

  return project
}
