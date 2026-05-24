import { prisma } from '@/lib/db'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { syncAlbumZipSizes } from '@/lib/album-zip-size-sync'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import { buildAlbumPhotoThumbnailStoragePath, buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { deleteFile } from '@/lib/storage'
import { getAlbumPhotoSocialQueue, getAlbumPhotoZipQueue } from '@/lib/queue'

export async function finalizeAlbumPhotoUpload(photoId: string): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
  const photo = await prisma.albumPhoto.findUnique({
    where: { id: photoId },
    include: { album: { include: { project: { select: { storagePath: true, title: true, companyName: true, client: { select: { name: true } } } } } } },
  })

  if (!photo) {
    return { ok: false, reason: 'not-found' }
  }

  const projectStoragePath = photo.album.project.storagePath
    || buildProjectStorageRoot(photo.album.project.client?.name || photo.album.project.companyName || 'Client', photo.album.project.title)
  const socialStoragePath = photo.socialStoragePath || `${photo.storagePath}-social.jpg`
  const thumbnailStoragePath = photo.thumbnailStoragePath || buildAlbumPhotoThumbnailStoragePath(projectStoragePath, photo.storagePath)

  await prisma.albumPhoto.update({
    where: { id: photo.id },
    data: {
      fileType: 'image/jpeg',
      status: 'READY',
      error: null,
      socialStoragePath,
      socialStatus: 'PENDING',
      socialError: null,
      thumbnailStoragePath,
      thumbnailStatus: 'PENDING',
      thumbnailError: null,
    },
  })

  await prisma.album.update({
    where: { id: photo.albumId },
    data: { status: 'PROCESSING' },
  }).catch(() => {})

  try {
    const socialQueue = getAlbumPhotoSocialQueue()
    await socialQueue.add(
      'process-album-photo-social',
      { photoId: photo.id },
      { jobId: `album-photo-social-${photo.id}` },
    )
  } catch (e) {
    console.warn('[ALBUM PHOTO FINALIZE] Failed to enqueue album photo social derivative job:', e)
  }

  try {
    await enqueueAlbumThumbnailJob({ albumId: photo.albumId })
  } catch (e) {
    console.warn('[ALBUM PHOTO FINALIZE] Failed to enqueue album photo thumbnail job:', e)
  }

  try {
    const fullZipPath = getAlbumZipStoragePath({
      projectId: photo.album.projectId,
      albumId: photo.albumId,
      albumName: photo.album.name,
      variant: 'full',
    })

    await deleteFile(fullZipPath).catch(() => {})

    if (photo.album.socialCopiesEnabled) {
      const socialZipPath = getAlbumZipStoragePath({
        projectId: photo.album.projectId,
        albumId: photo.albumId,
        albumName: photo.album.name,
        variant: 'social',
      })
      await deleteFile(socialZipPath).catch(() => {})
    }

    await syncAlbumZipSizes({ albumId: photo.albumId, projectId: photo.album.projectId }).catch(() => {})

    const zipQueue = getAlbumPhotoZipQueue()
    const delayMs = 30_000
    const fullJobId = getAlbumZipJobId({ albumId: photo.albumId, variant: 'full' })
    await zipQueue.remove(fullJobId).catch(() => {})
    await zipQueue.add('generate-album-zip', { albumId: photo.albumId, variant: 'full' }, { jobId: fullJobId, delay: delayMs })

    if (photo.album.socialCopiesEnabled) {
      const socialJobId = getAlbumZipJobId({ albumId: photo.albumId, variant: 'social' })
      await zipQueue.remove(socialJobId).catch(() => {})
      await zipQueue.add('generate-album-zip', { albumId: photo.albumId, variant: 'social' }, { jobId: socialJobId, delay: delayMs })
    }
  } catch (e) {
    console.warn('[ALBUM PHOTO FINALIZE] Failed to schedule album ZIP regeneration:', e)
  }

  return { ok: true }
}