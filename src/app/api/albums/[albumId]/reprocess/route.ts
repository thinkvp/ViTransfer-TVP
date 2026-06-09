import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile } from '@/lib/storage'
import { deleteStoredFile } from '@/lib/stored-file'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { syncAlbumZipSizes } from '@/lib/album-zip-size-sync'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import {
  recalculateAndStoreProjectPreviewBytes,
  recalculateAndStoreProjectDiskBytes,
  recalculateAndStoreProjectTotalBytes,
} from '@/lib/project-total-bytes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/albums/[albumId]/reprocess (admin)
// Fully reprocesses an album: regenerates ZIPs, photo thumbnails, and photo social copies.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ albumId: string }> }
) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'manageProjectAlbums')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 15, message: 'Too many requests. Please slow down.' },
    'album-reprocess'
  )
  if (rateLimitResult) return rateLimitResult

  const { albumId } = await params

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      projectId: true,
      name: true,
      storageFolderName: true,
      socialCopiesEnabled: true,
      project: {
        select: {
          storagePath: true,
          title: true,
          companyName: true,
          status: true,
          client: { select: { name: true } },
        },
      },
    },
  })

  if (!album) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  // Check project visibility
  if (auth.appRoleIsSystemAdmin !== true) {
    if (!isVisibleProjectStatusForUser(auth, album.project.status)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  if (album.project.status === 'CLOSED') {
    return NextResponse.json(
      { error: 'Closed projects cannot reprocess albums.' },
      { status: 409 }
    )
  }

  // Set album to PROCESSING so the UI reflects the change immediately
  await prisma.album.update({
    where: { id: album.id },
    data: { status: 'PROCESSING' },
  }).catch(() => {})

  const projectStoragePath =
    album.project.storagePath ||
    buildProjectStorageRoot(
      album.project.client?.name || album.project.companyName || 'Client',
      album.project.title
    )
  const albumFolderName = album.storageFolderName || album.name

  // --- 1. Delete existing ZIP files ---
  const fullZipPath = getAlbumZipStoragePath({
    projectStoragePath,
    albumFolderName,
    albumName: album.name,
    variant: 'full',
  })
  await deleteFile(fullZipPath).catch(() => {})
  await deleteStoredFile('ALBUM', album.id, 'ZIP_FULL').catch(() => {})

  if (album.socialCopiesEnabled) {
    const socialZipPath = getAlbumZipStoragePath({
      projectStoragePath,
      albumFolderName,
      albumName: album.name,
      variant: 'social',
    })
    await deleteFile(socialZipPath).catch(() => {})
    await deleteStoredFile('ALBUM', album.id, 'ZIP_SOCIAL').catch(() => {})
  }

  // Keep DB ZIP size totals consistent
  await syncAlbumZipSizes({ albumId: album.id, projectId: album.projectId }).catch(() => {})

  // --- 2. Reset photo social + thumbnail statuses ---
  const photoIds = await prisma.albumPhoto.findMany({
    where: { albumId: album.id, status: 'READY' },
    select: { id: true },
  })

  if (photoIds.length > 0) {
    await prisma.albumPhoto.updateMany({
      where: { id: { in: photoIds.map((p) => p.id) } },
      data: {
        socialStatus: 'PENDING',
        socialError: null,
        socialGeneratedAt: null,
        thumbnailStatus: 'PENDING',
        thumbnailError: null,
        thumbnailGeneratedAt: null,
      },
    })
  }

  // --- 3. Enqueue ZIP generation jobs ---
  let queuedZipJobs = 0
  try {
    const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
    const zipQueue = getAlbumPhotoZipQueue()

    const fullJobId = getAlbumZipJobId({ albumId: album.id, variant: 'full' })
    await zipQueue.remove(fullJobId).catch(() => {})
    await zipQueue.add(
      'generate-album-zip',
      { albumId: album.id, variant: 'full' },
      { jobId: fullJobId }
    )
    queuedZipJobs += 1

    if (album.socialCopiesEnabled) {
      const socialJobId = getAlbumZipJobId({ albumId: album.id, variant: 'social' })
      await zipQueue.remove(socialJobId).catch(() => {})
      await zipQueue.add(
        'generate-album-zip',
        { albumId: album.id, variant: 'social' },
        { jobId: socialJobId }
      )
      queuedZipJobs += 1
    }
  } catch {
    // ignore queue errors – ZIPs will be generated on next poll
  }

  // --- 4. Enqueue photo social copy jobs ---
  let queuedSocialJobs = 0
  if (photoIds.length > 0) {
    try {
      const { getAlbumPhotoSocialQueue } = await import('@/lib/queue')
      const socialQueue = getAlbumPhotoSocialQueue()

      for (const photo of photoIds) {
        await socialQueue.remove(`album-photo-social-${photo.id}`).catch(() => {})
        await socialQueue.add(
          'process-album-photo-social',
          { photoId: photo.id },
          { jobId: `album-photo-social-${photo.id}` }
        )
        queuedSocialJobs += 1
      }
    } catch {
      // ignore
    }
  }

  // --- 5. Enqueue photo thumbnail job ---
  let queuedThumbnailJobs = 0
  try {
    const jobId = await enqueueAlbumThumbnailJob({ albumId: album.id })
    if (jobId) queuedThumbnailJobs += 1
  } catch {
    // ignore
  }

  // --- 6. Recalculate project byte totals ---
  await Promise.allSettled([
    recalculateAndStoreProjectPreviewBytes(album.projectId),
    recalculateAndStoreProjectDiskBytes(album.projectId),
    recalculateAndStoreProjectTotalBytes(album.projectId),
  ])

  return NextResponse.json({
    success: true,
    queuedZipJobs,
    queuedSocialJobs,
    queuedThumbnailJobs,
  })
}
