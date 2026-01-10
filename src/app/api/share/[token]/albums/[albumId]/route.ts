import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { generateAlbumPhotoAccessToken } from '@/lib/photo-access'
import { albumZipExists, getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/share/[token]/albums/[albumId] - album details + photos (with tokenized URLs)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; albumId: string }> }
) {
  const { token, albumId } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    `share-album:${token}:${albumId}`
  )
  if (rateLimitResult) return rateLimitResult

  const projectMeta = await prisma.project.findUnique({
    where: { slug: token },
    select: { id: true, sharePassword: true, authMode: true, enablePhotos: true },
  })

  if (!projectMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (projectMeta.enablePhotos === false) {
    return NextResponse.json({ error: 'Album not found' }, { status: 404 })
  }

  const accessCheck = await verifyProjectAccess(request, projectMeta.id, projectMeta.sharePassword, projectMeta.authMode, {
    allowAnonymousNone: true,
  })

  if (!accessCheck.authorized) {
    return accessCheck.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    include: {
      photos: {
        where: { status: 'READY' },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!album || album.projectId !== projectMeta.id) {
    return NextResponse.json({ error: 'Album not found' }, { status: 404 })
  }

  const sessionId = accessCheck.shareTokenSessionId || (accessCheck.isAdmin ? `admin:${Date.now()}` : `guest:${Date.now()}`)

  const photos = await Promise.all(
    album.photos.map(async (p) => {
      const tokenValue = await generateAlbumPhotoAccessToken({
        photoId: p.id,
        albumId: album.id,
        projectId: album.projectId,
        request,
        sessionId,
      })

      return {
        id: p.id,
        fileName: p.fileName,
        fileSize: p.fileSize.toString(),
        createdAt: p.createdAt,
        url: `/api/content/photo/${tokenValue}`,
        downloadUrl: `/api/content/photo/${tokenValue}?download=true`,
        socialDownloadUrl: `/api/content/photo/${tokenValue}?download=true&variant=social`,
        socialReady: p.socialStatus === 'READY' && Boolean(p.socialStoragePath),
      }
    })
  )

  const fullZipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant: 'full' })
  const socialZipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant: 'social' })

  const fullZipReady = photos.length === 0 ? false : albumZipExists(fullZipStoragePath)
  const socialZipReady = photos.length === 0 ? false : albumZipExists(socialZipStoragePath)

  // Best-effort: if ZIPs are missing, enqueue generation so they can become available without manual admin action.
  if (photos.length > 0 && (!fullZipReady || !socialZipReady)) {
    try {
      const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
      const q = getAlbumPhotoZipQueue()
      const delayMs = 10_000

      if (!fullZipReady) {
        const jobId = getAlbumZipJobId({ albumId: album.id, variant: 'full' })
        await q.remove(jobId).catch(() => {})
        await q.add('generate-album-zip', { albumId: album.id, variant: 'full' }, { jobId, delay: delayMs }).catch(() => {})
      }
      if (!socialZipReady) {
        const jobId = getAlbumZipJobId({ albumId: album.id, variant: 'social' })
        await q.remove(jobId).catch(() => {})
        await q.add('generate-album-zip', { albumId: album.id, variant: 'social' }, { jobId, delay: delayMs }).catch(() => {})
      }
    } catch {
      // ignore
    }
  }

  return NextResponse.json({
    album: {
      id: album.id,
      name: album.name,
      notes: album.notes,
      createdAt: album.createdAt,
      photoCount: photos.length,
      zip: {
        fullReady: fullZipReady,
        socialReady: socialZipReady,
      },
    },
    photos,
  })
}
