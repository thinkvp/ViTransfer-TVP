import { prisma } from './db'
import { getVideoQueue } from './queue'

// Grace window: ignore very recently-touched rows so we never race a video that
// the web app just set to QUEUED moments before its job became visible in the
// queue. Mirrors the short grace used by the album-thumbnail reconciler.
const STUCK_GRACE_MS = 2 * 60 * 1000

/**
 * Recover videos left in QUEUED/PROCESSING with no backing BullMQ job.
 *
 * When the worker is killed mid-transcode (deploy, OOM, crash) a Video row can
 * stay PROCESSING forever: nothing reconciles it back. Such a row is a dead zone
 * in the UI — both the Running Jobs clear action and the Reprocess action refuse
 * to touch a PROCESSING video (the clear path now also handles stalled rows, but
 * only while an admin is watching). This runs on worker startup, finds
 * QUEUED/PROCESSING videos that have NO job in any pending state in the queue,
 * and flips them to ERROR so they surface as failed and can be reprocessed.
 *
 * A row is only considered orphaned when there is no matching job in active,
 * waiting, delayed or prioritized. A crashed worker's job stays in 'active'
 * until BullMQ's stalled-check reclaims it, so leaving those alone lets the
 * normal stalled-job recovery run instead of fighting it.
 */
export async function reconcileStuckVideos(): Promise<{ recovered: number }> {
  const graceCutoff = new Date(Date.now() - STUCK_GRACE_MS)

  const stuckVideos = await prisma.video.findMany({
    where: {
      status: { in: ['QUEUED', 'PROCESSING'] },
      updatedAt: { lt: graceCutoff },
    },
    select: { id: true },
  })

  if (stuckVideos.length === 0) return { recovered: 0 }

  // Collect every videoId that still has a live or pending queue job.
  const videoQueue = getVideoQueue()
  const jobs = await videoQueue.getJobs(['active', 'waiting', 'delayed', 'prioritized'])
  const videoIdsWithJob = new Set<string>()
  for (const job of jobs) {
    const vid = job?.data?.videoId
    if (typeof vid === 'string' && vid) videoIdsWithJob.add(vid)
  }

  const orphanedIds = stuckVideos
    .filter((v) => !videoIdsWithJob.has(v.id))
    .map((v) => v.id)

  if (orphanedIds.length === 0) return { recovered: 0 }

  const result = await prisma.video.updateMany({
    where: { id: { in: orphanedIds } },
    data: {
      status: 'ERROR',
      processingPhase: null,
      processingProgress: 0,
      processingError:
        'Processing was interrupted (worker restart) with no active job; marked failed by the startup reconciler. Reprocess to retry.',
    },
  })

  return { recovered: result.count }
}
