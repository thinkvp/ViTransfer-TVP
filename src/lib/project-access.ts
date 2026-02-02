import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUserFromRequest, getShareContext } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  isVisibleProjectStatusForUser,
  requireAnyActionAccess,
  requireMenuAccess,
} from '@/lib/rbac-api'
import type { Project, Video } from '@prisma/client'

/**
 * Verify project access using dual authentication pattern
 *
 * Two authentication paths:
 * 1. Admin Path: JWT authentication (bypasses password protection)
 * 2. Share Path: bearer share token scoped to project
 *
 * This replaces duplicate auth logic in 6+ API routes.
 *
 * @param request - Next.js request object
 * @param projectId - Project ID to verify access for
 * @param sharePassword - Project's share password (null if not password-protected)
 * @returns Object with authorization status and user type
 */
export async function verifyProjectAccess(
  request: NextRequest,
  projectId: string,
  sharePassword: string | null,
  authMode: string = 'PASSWORD',
  options?: { allowAnonymousNone?: boolean }
): Promise<{
  authorized: boolean
  isAdmin: boolean
  isAuthenticated: boolean
  isGuest?: boolean
  shareTokenSessionId?: string
  errorResponse?: Response
}> {
  // Check if user is admin (admins bypass password protection)
  const currentUser = await getCurrentUserFromRequest(request)
  const isAdmin = !!currentUser
  const shareContext = await getShareContext(request)

  if (isAdmin) {
    const forbiddenMenu = requireMenuAccess(currentUser, 'projects')
    if (forbiddenMenu) {
      return {
        authorized: false,
        isAdmin: true,
        isAuthenticated: true,
        errorResponse: forbiddenMenu,
      }
    }

    const forbiddenAction = requireAnyActionAccess(currentUser, [
      'accessSharePage',
      'accessProjectSettings',
      'uploadVideosOnProjects',
      'changeProjectSettings',
      'changeProjectStatuses',
      'manageProjectAlbums',
    ])
    if (forbiddenAction) {
      return {
        authorized: false,
        isAdmin: true,
        isAuthenticated: true,
        errorResponse: forbiddenAction,
      }
    }

    // Enforce project assignment + status visibility for non-system-admin users.
    if (!currentUser.appRoleIsSystemAdmin) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          status: true,
          assignedUsers: { select: { userId: true } },
        },
      })

      if (!project) {
        return {
          authorized: false,
          isAdmin: true,
          isAuthenticated: true,
          errorResponse: NextResponse.json({ error: 'Project not found' }, { status: 404 }),
        }
      }

      const isAssigned = project.assignedUsers.some((u) => u.userId === currentUser.id)
      if (!isAssigned) {
        return {
          authorized: false,
          isAdmin: true,
          isAuthenticated: true,
          errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
        }
      }

      const isStatusVisible = isVisibleProjectStatusForUser(currentUser, project.status)
      if (!isStatusVisible) {
        return {
          authorized: false,
          isAdmin: true,
          isAuthenticated: true,
          errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
        }
      }
    }

    return {
      authorized: true,
      isAdmin: true,
      isAuthenticated: true,
      shareTokenSessionId: `admin:${currentUser.id}`,
    }
  }

  // If the project is CLOSED, block all external/share access.
  // (Admins can still access via the early-return above.)
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true },
    })
    if (project?.status === 'CLOSED') {
      return {
        authorized: false,
        isAdmin: false,
        isAuthenticated: false,
        errorResponse: NextResponse.json(
          { error: 'Project is closed' },
          { status: 403 }
        ),
      }
    }
  } catch (e) {
    // If we cannot verify status, be conservative and deny.
    return {
      authorized: false,
      isAdmin: false,
      isAuthenticated: false,
      errorResponse: NextResponse.json(
        { error: 'Unable to verify project access' },
        { status: 403 }
      ),
    }
  }

  const isNoneAuthMode = authMode === 'NONE'
  if (isNoneAuthMode && !shareContext && options?.allowAnonymousNone) {
    // "NONE" means no password/OTP barrier, but we still prefer a signed share token
    // for subsequent API calls (revocation/auditing/consistent gating).
    return {
      authorized: true,
      isAdmin: false,
      isAuthenticated: false,
      isGuest: false,
    }
  }

  if (!shareContext) {
    return {
      authorized: false,
      isAdmin: false,
      isAuthenticated: false,
      errorResponse: NextResponse.json(
        { error: 'Authentication required', authMode },
        { status: 401 }
      )
    }
  }

  if (shareContext.projectId !== projectId) {
    return {
      authorized: false,
      isAdmin: false,
      isAuthenticated: false,
      errorResponse: NextResponse.json(
        { error: 'Access denied' },
        { status: 401 }
      )
    }
  }

  const isGuest = !!shareContext.guest

  return {
    authorized: true,
    isAdmin: false,
    isAuthenticated: true,
    isGuest,
    shareTokenSessionId: shareContext.sessionId,
  }
}

export async function fetchProjectWithVideos(
  token: string,
  isGuest: boolean,
  guestLatestOnly: boolean,
  projectId: string
) {
  if (isGuest && guestLatestOnly) {
    const allVideos = await prisma.video.findMany({
      where: {
        projectId,
        status: 'READY',
      },
      orderBy: { version: 'desc' },
    })

    const latestVideoIds: string[] = []
    const seenNames = new Set<string>()
    for (const video of allVideos) {
      if (!seenNames.has(video.name)) {
        latestVideoIds.push(video.id)
        seenNames.add(video.name)
      }
    }

    return prisma.project.findUnique({
      where: { slug: token },
      include: {
        videos: {
          where: {
            id: { in: latestVideoIds },
            status: 'READY',
          },
          orderBy: { version: 'desc' },
        },
      },
    })
  }

  return prisma.project.findUnique({
    where: { slug: token },
    include: {
      videos: {
        where: { status: 'READY' as const },
        orderBy: { version: 'desc' },
      },
    },
  })
}
