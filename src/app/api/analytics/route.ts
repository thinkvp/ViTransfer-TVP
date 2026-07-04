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

    // Analytics view does not enforce project assignment — non-admin users
    // with the analytics menu can see stats for all projects in allowed statuses.
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

    // All event aggregates are computed in the database. Previously every SharePageAccess
    // and counted download row was included on each project and counted/deduped in JS,
    // so request cost grew with total event history rather than with project count.
    const [
      visitAgg,
      sessionAgg,
      downloadsAgg,
      maxShareAccess,
      maxVideoAnalytics,
      maxAlbumAnalytics,
      maxDirectAccess,
    ] = await Promise.all([
      // Visit counts per (project, accessMethod); summed per project for totals.
      projectIds.length
        ? prisma.sharePageAccess.groupBy({
            by: ['projectId', 'accessMethod'],
            where: { projectId: { in: projectIds }, eventType: { not: 'SWITCH_AWAY' } },
            _count: { _all: true },
          })
        : Promise.resolve([] as any[]),
      // Unique visitors: one row per (project, session) — Prisma has no COUNT(DISTINCT),
      // so the groups are counted below (bounded by unique sessions, not total events).
      projectIds.length
        ? prisma.sharePageAccess.groupBy({
            by: ['projectId', 'sessionId'],
            where: { projectId: { in: projectIds }, eventType: { not: 'SWITCH_AWAY' } },
          })
        : Promise.resolve([] as any[]),
      projectIds.length
        ? prisma.videoAnalytics.groupBy({
            by: ['projectId'],
            where: { projectId: { in: projectIds }, eventType: { in: COUNTED_DOWNLOAD_EVENT_TYPES } },
            _count: { _all: true },
          })
        : Promise.resolve([] as any[]),
      // Max activity timestamps per project from the three most relevant event tables.
      // These are more accurate than project.updatedAt for "Last Activity" display.
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
      projectIds.length
        ? prisma.sharePageAccess.groupBy({
            by: ['projectId'],
            where: {
              projectId: { in: projectIds },
              eventType: 'ACCESS',
            },
            _max: { createdAt: true },
          })
        : Promise.resolve([] as any[]),
    ])

    const visitsByPid: Record<string, { total: number; byMethod: Record<string, number> }> = {}
    for (const g of visitAgg as any[]) {
      const id = String(g?.projectId ?? '').trim()
      if (!id) continue
      const count = Number(g?._count?._all ?? 0)
      const entry = (visitsByPid[id] ??= { total: 0, byMethod: {} })
      entry.total += count
      const method = typeof g?.accessMethod === 'string' ? g.accessMethod : null
      if (method) entry.byMethod[method] = (entry.byMethod[method] ?? 0) + count
    }

    const uniqueSessionsByPid: Record<string, number> = {}
    for (const g of sessionAgg as any[]) {
      const id = String(g?.projectId ?? '').trim()
      if (!id) continue
      uniqueSessionsByPid[id] = (uniqueSessionsByPid[id] ?? 0) + 1
    }

    const downloadsByPid: Record<string, number> = {}
    for (const g of downloadsAgg as any[]) {
      const id = String(g?.projectId ?? '').trim()
      if (!id) continue
      downloadsByPid[id] = Number(g?._count?._all ?? 0)
    }

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
    const maxDirectAccessByPid: Record<string, string | null> = {}
    for (const g of maxDirectAccess as any[]) {
      const id = String(g?.projectId ?? '').trim()
      if (id) maxDirectAccessByPid[id] = toIsoOrNull(g?._max?.createdAt)
    }
    const projectsWithAnalytics = projects.map(project => {
      const totalDownloads = downloadsByPid[project.id] ?? 0
      const displayName = project.companyName || project.recipients[0]?.name || project.recipients[0]?.email || 'Client'
      const visits = visitsByPid[project.id]

      const readyVideos = project.videos.filter(v => v.status === 'READY')

      // Unique sessions (unique users who accessed the share page)
      const uniqueSessions = uniqueSessionsByPid[project.id] ?? 0

      // Count by access method
      const accessByMethod = {
        OTP: visits?.byMethod['OTP'] ?? 0,
        PASSWORD: visits?.byMethod['PASSWORD'] ?? 0,
        GUEST: visits?.byMethod['GUEST'] ?? 0,
        NONE: visits?.byMethod['NONE'] ?? 0,
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

      const lastAccessedAt = toIsoOrNull(project.lastAccessedAt) || maxDirectAccessByPid[project.id] || null

      return {
        id: project.id,
        title: project.title,
        recipientName: displayName,
        recipientEmail: project.companyName ? null : project.recipients[0]?.email || null,
        status: project.status,
        videoCount: readyVideos.length,
        videos: project.videos,
        commentsCount: project._count.comments,
        totalVisits: visits?.total ?? 0,
        uniqueVisits: uniqueSessions,
        accessByMethod,
        totalDownloads,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        lastActivityAt,
        lastAccessedAt,
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
