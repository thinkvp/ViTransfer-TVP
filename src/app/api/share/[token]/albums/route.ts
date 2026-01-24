import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { generateAlbumPhotoAccessToken } from '@/lib/photo-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function asNumberBigInt(v: unknown): number {
  if (typeof v === 'bigint') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

// GET /api/share/[token]/albums - list albums visible on share page
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    `share-albums:${token}`
  )
  if (rateLimitResult) return rateLimitResult

  const projectMeta = await prisma.project.findUnique({
    where: { slug: token },
    select: { id: true, sharePassword: true, authMode: true, guestMode: true, status: true, enablePhotos: true },
  })

  if (!projectMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const accessCheck = await verifyProjectAccess(request, projectMeta.id, projectMeta.sharePassword, projectMeta.authMode, {
    allowAnonymousNone: true,
  })

  if (!accessCheck.authorized) {
    return accessCheck.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const sessionId = accessCheck.shareTokenSessionId || (accessCheck.isAdmin ? `admin:${Date.now()}` : `guest:${Date.now()}`)

  // Project type gating: Photos disabled.
  if (projectMeta.enablePhotos === false) {
    return NextResponse.json({ albums: [] })
  }

  const albums = await prisma.album.findMany({
    where: { projectId: projectMeta.id },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      projectId: true,
      name: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      fullZipFileSize: true,
      socialZipFileSize: true,
      _count: { select: { photos: true } },
      photos: {
        where: { status: 'READY' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { id: true },
      },
    },
  })

  const albumsSafe = await Promise.all(
    albums.map(async (a) => {
      const firstPhotoId = (a as any)?.photos?.[0]?.id as string | undefined
      let previewPhotoUrl: string | null = null

      if (firstPhotoId) {
        try {
          const tokenValue = await generateAlbumPhotoAccessToken({
            photoId: firstPhotoId,
            albumId: a.id,
            projectId: a.projectId,
            request,
            sessionId,
          })
          previewPhotoUrl = `/api/content/photo/${tokenValue}`
        } catch {
          // ignore
        }
      }

      return {
        ...a,
        previewPhotoUrl,
        fullZipFileSize: asNumberBigInt((a as any).fullZipFileSize),
        socialZipFileSize: asNumberBigInt((a as any).socialZipFileSize),
      }
    })
  )

  return NextResponse.json({ albums: albumsSafe })
}
