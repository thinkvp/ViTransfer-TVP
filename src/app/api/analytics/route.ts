import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
export const runtime = 'nodejs'

export const dynamic = 'force-dynamic'

const COUNTED_DOWNLOAD_EVENT_TYPES = ['DOWNLOAD_COMPLETE', 'DOWNLOAD_SUCCEEDED']

// GET /api/analytics - Get analytics for all projects
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'analytics')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'viewAnalytics')
  if (forbiddenAction) return forbiddenAction

  // Rate limiting: 100 requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: 'Too many requests. Please slow down.'
  }, 'admin-analytics-list')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const permissions = getUserPermissions(authResult)
    const allowedStatuses = permissions.projectVisibility.statuses

    if (!Array.isArray(allowedStatuses) || allowedStatuses.length === 0) {
      const response = NextResponse.json({ projects: [] })
      response.headers.set('Cache-Control', 'no-store')
      response.headers.set('Pragma', 'no-cache')
      return response
    }

    const projects = await prisma.project.findMany({
      where: {
        status: { in: allowedStatuses as any },
      },
      include: {
        videos: {
          select: {
            id: true,
            status: true,
            name: true,
            approved: true,
          },
        },
        recipients: {
          where: { isPrimary: true },
          take: 1,
        },
        sharePageAccesses: {
          select: {
            eventType: true,
            accessMethod: true,
            sessionId: true,
          },
        },
        analytics: {
          where: { eventType: { in: COUNTED_DOWNLOAD_EVENT_TYPES } },
          select: {
            eventType: true,
          },
        },
        _count: {
          select: {
            comments: true,
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    })

    const projectIds = projects.map(p => p.id)

    // Fetch max activity timestamps per project from the three most relevant event tables.
    // These are more accurate than project.updatedAt for "Last Activity" display.
    const [maxShareAccess, maxVideoAnalytics, maxAlbumAnalytics] = await Promise.all([
      projectIds.length
        ? prisma.sharePageAccess.groupBy({
            by: ['projectId'],
            where: { projectId: { in: projectIds } },
            _max: { createdAt: true },
          })
        : Promise.resolve([] as any[]),
      projectIds.length
        ? prisma.videoAnalytics.groupBy({
            by: ['projectId'],
            where: { projectId: { in: projectIds } },
            _max: { createdAt: true },
          })
        : Promise.resolve([] as any[]),
      projectIds.length
        ? prisma.albumAnalytics.groupBy({
            by: ['projectId'],
            where: { projectId: { in: projectIds } },
            _max: { createdAt: true },
          })
        : Promise.resolve([] as any[]),
    ])

    const toIsoOrNull = (dt: unknown): string | null => {
      if (dt instanceof Date) return dt.toISOString()
      if (typeof dt === 'string' && dt.length > 0) return dt
      return null
    }

    const maxShareByPid: Record<string, string | null> = {}
    for (const g of maxShareAccess as any[]) {
      const id = String(g?.projectId ?? '').trim()
      if (id) maxShareByPid[id] = toIsoOrNull(g?._max?.createdAt)
    }
    const maxVideoByPid: Record<string, string | null> = {}
    for (const g of maxVideoAnalytics as any[]) {
      const id = String(g?.projectId ?? '').trim()
      if (id) maxVideoByPid[id] = toIsoOrNull(g?._max?.createdAt)
    }
    const maxAlbumByPid: Record<string, string | null> = {}
    for (const g of maxAlbumAnalytics as any[]) {
      const id = String(g?.projectId ?? '').trim()
      if (id) maxAlbumByPid[id] = toIsoOrNull(g?._max?.createdAt)
    }

    const projectsWithAnalytics = projects.map(project => {
      const totalDownloads = project.analytics.length
      const displayName = project.companyName || project.recipients[0]?.name || project.recipients[0]?.email || 'Client'
      const visitEvents = project.sharePageAccesses.filter(a => a.eventType !== 'SWITCH_AWAY')

      const readyVideos = project.videos.filter(v => v.status === 'READY')

      // Calculate unique sessions (unique users who accessed the share page)
      const uniqueSessions = new Set(
        visitEvents.map(a => a.sessionId)
      ).size

      // Count by access method
      const accessByMethod = {
        OTP: visitEvents.filter(a => a.accessMethod === 'OTP').length,
        PASSWORD: visitEvents.filter(a => a.accessMethod === 'PASSWORD').length,
        GUEST: visitEvents.filter(a => a.accessMethod === 'GUEST').length,
        NONE: visitEvents.filter(a => a.accessMethod === 'NONE').length,
      }

      // Compute the most recent genuine activity across event tables,
      // falling back to project.updatedAt if no event records exist.
      const updatedAtIso = toIsoOrNull(project.updatedAt) ?? new Date(0).toISOString()
      const lastActivityAt = [
        updatedAtIso,
        maxShareByPid[project.id],
        maxVideoByPid[project.id],
        maxAlbumByPid[project.id],
      ]
        .filter((d): d is string => typeof d === 'string' && d.length > 0)
        .sort()
        .at(-1) ?? updatedAtIso

      return {
        id: project.id,
        title: project.title,
        recipientName: displayName,
        recipientEmail: project.companyName ? null : project.recipients[0]?.email || null,
        status: project.status,
        videoCount: readyVideos.length,
        videos: project.videos,
        commentsCount: project._count.comments,
        totalVisits: visitEvents.length,
        uniqueVisits: uniqueSessions,
        accessByMethod,
        totalDownloads,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        lastActivityAt,
      }
    })

    const response = NextResponse.json({ projects: projectsWithAnalytics })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    return NextResponse.json(
      { error: 'Unable to process request' },
      { status: 500 }
    )
  }
}
