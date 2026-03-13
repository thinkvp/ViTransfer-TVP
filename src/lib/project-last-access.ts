import { prisma } from './db'
import type { NextRequest } from 'next/server'
import { getClientIpAddress } from './utils'
import { isLikelyAdminIp } from './admin-ip-match'

export async function touchProjectLastAccess(projectId: string) {
  if (!projectId) {
    return
  }

  await prisma.$executeRaw`
    UPDATE "Project"
    SET "lastAccessedAt" = NOW()
    WHERE "id" = ${projectId}
  `
}

export async function touchProjectLastAccessForRequest(params: {
  projectId: string
  request: NextRequest
  sessionId?: string | null
}) {
  const { projectId, request, sessionId } = params

  if (!projectId) {
    return
  }

  if (sessionId?.startsWith('admin:')) {
    return
  }

  const ipAddress = getClientIpAddress(request)
  const likelyAdmin = await isLikelyAdminIp(ipAddress).catch(() => false)
  if (likelyAdmin) {
    return
  }

  await touchProjectLastAccess(projectId)
}
