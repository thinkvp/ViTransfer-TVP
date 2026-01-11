import { prisma } from './db'

export type ProjectAssignedUser = {
  id: string
  email: string
  name: string | null
  isSystemAdmin: boolean
  receiveNotifications: boolean
}

export async function getProjectAssignedUsers(projectId: string): Promise<ProjectAssignedUser[]> {
  const rows = await prisma.projectUser.findMany({
    where: { projectId },
    select: {
      receiveNotifications: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          appRole: { select: { isSystemAdmin: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return rows
    .map((r) => ({
      id: r.user.id,
      email: r.user.email,
      name: r.user.name,
      isSystemAdmin: r.user.appRole?.isSystemAdmin === true,
      receiveNotifications: r.receiveNotifications !== false,
    }))
    .filter((u) => Boolean(u.email))
}

export async function getProjectNotificationUsers(projectId: string): Promise<ProjectAssignedUser[]> {
  const users = await getProjectAssignedUsers(projectId)
  return users.filter((u) => u.receiveNotifications && u.email)
}
