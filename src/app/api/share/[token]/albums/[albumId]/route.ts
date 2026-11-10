import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import { buildAlbumPhotoPayloads, enqueueMissingAlbumZips, getAlbumZipReadiness } from '@/lib/album-share'

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
    select: {
      id: true,
      projectId: true,
      name: true,
      notes: true,
      createdAt: true,
      storageFolderName: true,
      socialCopiesEnabled: true,
      project: {
        select: {
          storagePath: true,
          title: true,
          companyName: true,
          client: { select: { name: true } },
        },
      },
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

  // Thumbnails and lightbox previews are presigned direct-to-R2 in S3 mode (CrowdSec: paging
  // through ~40+ token URLs bans the viewer). Full-size/download URLs stay token URLs.
  const photos = await buildAlbumPhotoPayloads({
    photos: album.photos,
    albumId: album.id,
    projectId: album.projectId,
    request,
    sessionId,
  })

  if (album.photos.some((p) => p.thumbnailStatus !== 'READY')) {
    void enqueueAlbumThumbnailJob({ albumId: album.id, delayMs: 500 }).catch(() => {})
  }

  const zipReadiness = photos.length === 0
    ? { fullReady: false, socialReady: false }
    : await getAlbumZipReadiness(album)
  const fullZipReady = zipReadiness.fullReady
  const socialZipReady = zipReadiness.socialReady

  // Best-effort: if ZIPs are missing, enqueue generation so they can become available without manual admin action.
  if (photos.length > 0) {
    await enqueueMissingAlbumZips(album, zipReadiness)
  }

  return NextResponse.json({
    album: {
      id: album.id,
      name: album.name,
      notes: album.notes,
      createdAt: album.createdAt,
      photoCount: photos.length,
      socialCopiesEnabled: album.socialCopiesEnabled,
      zip: {
        fullReady: fullZipReady,
        socialReady: socialZipReady,
      },
    },
    photos,
  })
}
