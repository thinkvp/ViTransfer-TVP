import { prisma } from '@/lib/db'
import { getAlbumPhotoThumbnailQueue } from '@/lib/queue'

export function getAlbumThumbnailQueueJobId(albumId: string): string {
  return `album-photo-thumbnail-${albumId}`
}

export async function enqueueAlbumThumbnailJob(params: {
  albumId: string
  delayMs?: number
}): Promise<string | null> {
  const { albumId, delayMs = 0 } = params

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      name: true,
      projectId: true,
      project: { select: { title: true } },
    },
  })

  if (!album) return null

  let albumThumbnailJob = await prisma.albumThumbnailJob.findFirst({
    where: {
      albumId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!albumThumbnailJob) {
    albumThumbnailJob = await prisma.albumThumbnailJob.create({
      data: {
        albumId: album.id,
        projectId: album.projectId,
        albumName: album.name,
        projectName: album.project.title,
      },
    })
  } else if (albumThumbnailJob.status === 'PENDING') {
    albumThumbnailJob = await prisma.albumThumbnailJob.update({
      where: { id: albumThumbnailJob.id },
      data: {
        albumName: album.name,
        projectName: album.project.title,
        error: null,
      },
    })
  }

  if (albumThumbnailJob.status === 'IN_PROGRESS') {
    return albumThumbnailJob.id
  }

  const queue = getAlbumPhotoThumbnailQueue()
  const queueJobId = getAlbumThumbnailQueueJobId(albumId)
  try {
    await queue.remove(queueJobId).catch(() => {})
    await queue.add(
      'process-album-photo-thumbnail',
      { albumThumbnailJobId: albumThumbnailJob.id },
      { jobId: queueJobId, delay: delayMs },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.albumThumbnailJob.update({
      where: { id: albumThumbnailJob.id },
      data: {
        status: 'FAILED',
        error: `Failed to enqueue thumbnail job: ${message}`.substring(0, 2000),
        completedAt: new Date(),
      },
    }).catch(() => {})
    throw error
  }

  return albumThumbnailJob.id
}