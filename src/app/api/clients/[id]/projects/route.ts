import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/clients/[id]/projects - list projects assigned to a client
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  // Client page access gate
  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-client-projects-list'
  )
  if (rateLimitResult) return rateLimitResult

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
        clientId: id,
        status: { in: allowedStatuses as any },
      },
      select: {
        id: true,
        title: true,
        status: true,
        startDate: true,
        createdAt: true,
        updatedAt: true,
        lastAccessedAt: true,
        videos: {
          select: {
            id: true,
            status: true,
            name: true,
            approved: true,
          },
        },
        _count: {
          select: {
            comments: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    const projectIds = projects.map(p => p.id)

    const photoCountByProjectId = new Map<string, number>()

    if (projectIds.length > 0) {
      const albumRows = await prisma.album.findMany({
        where: { projectId: { in: projectIds } },
        select: {
          projectId: true,
          _count: { select: { photos: true } },
        },
      })
      for (const row of albumRows) {
        const prev = photoCountByProjectId.get(row.projectId) ?? 0
        photoCountByProjectId.set(row.projectId, prev + (row._count?.photos ?? 0))
      }
    }

    const toIsoOrNull = (dt: unknown): string | null => {
      if (dt instanceof Date) return dt.toISOString()
      if (typeof dt === 'string' && dt.length > 0) return dt
      return null
    }

    const [maxShareAccess, maxVideoAnalytics, maxAlbumAnalytics, maxDirectAccess] = await Promise.all([
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

    const maxShareByPid: Record<string, string | null> = {}
    for (const g of maxShareAccess as any[]) {
      const pid = String(g?.projectId ?? '').trim()
      if (pid) maxShareByPid[pid] = toIsoOrNull(g?._max?.createdAt)
    }
    const maxVideoByPid: Record<string, string | null> = {}
    for (const g of maxVideoAnalytics as any[]) {
      const pid = String(g?.projectId ?? '').trim()
      if (pid) maxVideoByPid[pid] = toIsoOrNull(g?._max?.createdAt)
    }
    const maxAlbumByPid: Record<string, string | null> = {}
    for (const g of maxAlbumAnalytics as any[]) {
      const pid = String(g?.projectId ?? '').trim()
      if (pid) maxAlbumByPid[pid] = toIsoOrNull(g?._max?.createdAt)
    }
    const maxDirectAccessByPid: Record<string, string | null> = {}
    for (const g of maxDirectAccess as any[]) {
      const pid = String(g?.projectId ?? '').trim()
      if (pid) maxDirectAccessByPid[pid] = toIsoOrNull(g?._max?.createdAt)
    }
    const projectsWithActivity = projects.map((project) => {
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

      return { ...project, lastActivityAt, lastAccessedAt, photoCount: photoCountByProjectId.get(project.id) ?? 0 }
    })

    const response = NextResponse.json({ projects: projectsWithActivity })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch {
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
