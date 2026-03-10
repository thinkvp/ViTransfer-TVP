import { getVideoQueue, getAlbumPhotoSocialQueue, getAlbumPhotoZipQueue } from './queue'
import { getAlbumZipJobId, AlbumZipVariant } from './album-photo-zip'
import { prisma } from './db'

type PreviewResolution = '480p' | '720p' | '1080p'

function sanitizeRequestedPreviewResolutions(value: unknown): PreviewResolution[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(
    (resolution): resolution is PreviewResolution =>
      resolution === '480p' || resolution === '720p' || resolution === '1080p'
  )
}

/**
 * Cancel all pending/waiting BullMQ jobs for a project.
 * Removes waiting, delayed, and prioritized jobs from the video-processing,
 * album-photo-social, and album-photo-zip queues.
 */
export async function cancelProjectJobs(projectId: string): Promise<{ cancelled: number }> {
  let cancelled = 0

  // 1. Cancel video-processing jobs for this project
  try {
    const videoQueue = getVideoQueue()
    const videoJobs = await videoQueue.getJobs(['waiting', 'delayed', 'prioritized'])
    for (const job of videoJobs) {
      if (job?.data?.projectId === projectId) {
        await job.remove().catch(() => {})
        cancelled++
      }
    }
  } catch (err) {
    console.error(`[JOB-CANCEL] Error cancelling video jobs for project ${projectId}:`, err)
  }

  // 2. Cancel album-photo-zip jobs for this project's albums
  try {
    const albums = await prisma.album.findMany({
      where: { projectId },
      select: { id: true },
    })
    if (albums.length > 0) {
      const zipQueue = getAlbumPhotoZipQueue()
      for (const album of albums) {
        for (const variant of ['full', 'social'] as AlbumZipVariant[]) {
          const jobId = getAlbumZipJobId({ albumId: album.id, variant })
          try {
            await zipQueue.remove(jobId)
            cancelled++
          } catch {
            // Job may not exist or already completed
          }
        }
      }
    }
  } catch (err) {
    console.error(`[JOB-CANCEL] Error cancelling album ZIP jobs for project ${projectId}:`, err)
  }

  // 3. Cancel album-photo-social jobs for this project's album photos
  try {
    const photos = await prisma.albumPhoto.findMany({
      where: { album: { projectId } },
      select: { id: true },
    })
    if (photos.length > 0) {
      const socialQueue = getAlbumPhotoSocialQueue()
      const photoIds = new Set(photos.map(p => p.id))
      const socialJobs = await socialQueue.getJobs(['waiting', 'delayed', 'prioritized'])
      for (const job of socialJobs) {
        if (job?.data?.photoId && photoIds.has(job.data.photoId)) {
          await job.remove().catch(() => {})
          cancelled++
        }
      }
    }
  } catch (err) {
    console.error(`[JOB-CANCEL] Error cancelling album photo social jobs for project ${projectId}:`, err)
  }

  if (cancelled > 0) {
    console.log(`[JOB-CANCEL] Cancelled ${cancelled} pending job(s) for project ${projectId}`)
  }

  return { cancelled }
}

export async function cancelProjectPreviewResolutionJobs(
  projectId: string,
  removedResolutions: PreviewResolution[]
): Promise<{ cancelled: number; updated: number }> {
  let cancelled = 0
  let updated = 0

  if (removedResolutions.length === 0) {
    return { cancelled, updated }
  }

  const removedResolutionSet = new Set(removedResolutions)

  try {
    const videoQueue = getVideoQueue()
    const videoJobs = await videoQueue.getJobs(['waiting', 'delayed', 'prioritized'])

    for (const job of videoJobs) {
      if (job?.data?.projectId !== projectId || job?.data?.timelineOnly) {
        continue
      }

      const requestedPreviewResolutions = sanitizeRequestedPreviewResolutions(job.data?.requestedPreviewResolutions)
      if (requestedPreviewResolutions.length === 0) {
        continue
      }

      const remainingRequestedResolutions = requestedPreviewResolutions
        .filter((resolution) => !removedResolutionSet.has(resolution))

      if (remainingRequestedResolutions.length === requestedPreviewResolutions.length) {
        continue
      }

      const isPreviewOnlyJob = job.data.regenerateThumbnail === false && job.data.regenerateTimelinePreviews === false

      if (remainingRequestedResolutions.length === 0 && isPreviewOnlyJob) {
        await job.remove().catch(() => {})
        cancelled++
        continue
      }

      const nextJobData = remainingRequestedResolutions.length > 0
        ? { ...job.data, requestedPreviewResolutions: remainingRequestedResolutions }
        : (() => {
            const { requestedPreviewResolutions: _removed, ...rest } = job.data
            return rest
          })()

      await job.updateData(nextJobData)
      updated++
    }
  } catch (err) {
    console.error(`[JOB-CANCEL] Error updating preview jobs for project ${projectId}:`, err)
  }

  if (cancelled > 0 || updated > 0) {
    console.log(
      `[JOB-CANCEL] Updated preview queue for project ${projectId}: cancelled ${cancelled}, updated ${updated}`
    )
  }

  return { cancelled, updated }
}
