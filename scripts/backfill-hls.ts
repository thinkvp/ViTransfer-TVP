/**
 * Backfill / upgrade HLS for existing videos to the current packaging version.
 *
 * HLS ABR requires keyframe-aligned renditions, which is a property of the *transcode* — so
 * upgrading a legacy bundle isn't a cheap repackage, it's a full re-transcode. This script
 * enqueues a normal (full) video-processing job per video whose `hlsVersion` is below the
 * current `HLS_PACKAGE_VERSION`: the worker re-transcodes the previews with forced keyframes
 * (`alignKeyframes`), then `-c copy`-remuxes them into an aligned HLS bundle and stamps the
 * new version. Videos already at the current version are skipped (idempotent).
 *
 * Only runs in S3 mode — HLS is delivered direct-from-R2, so there's nothing to do on local disk.
 *
 * Usage:
 *   docker compose run --rm --no-deps app npx tsx scripts/backfill-hls.ts
 *
 * Options (env vars):
 *   DRY_RUN=1     — report what would be enqueued, don't enqueue
 *   LIMIT=50      — cap how many jobs are enqueued this run (for staged rollout)
 */

import { prisma } from '../src/lib/db'
import { isS3Mode } from '../src/lib/s3-storage'
import { getVideoQueue, enqueueShareUploadPreview } from '../src/lib/queue'
import { HLS_PACKAGE_VERSION } from '../src/lib/video-stream-url'

const DRY_RUN = process.env.DRY_RUN === '1'
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined

async function main() {
  if (!isS3Mode()) {
    console.log('[backfill-hls] STORAGE_PROVIDER is not s3 — HLS is delivered direct-from-R2 only. Nothing to do.')
    return
  }

  // READY videos not yet at the current (keyframe-aligned, ABR-safe) packaging version.
  // Closed projects are excluded: their share access is revoked and (with auto-delete)
  // their renditions are deliberately shed, so a full re-transcode would just rebuild
  // what the close threw away. Reopening a project makes its videos eligible again.
  const candidates = await prisma.video.findMany({
    where: {
      status: 'READY',
      hlsVersion: { lt: HLS_PACKAGE_VERSION },
      project: { status: { not: 'CLOSED' } },
    },
    select: { id: true, projectId: true },
  })

  // Resolve each video's ORIGINAL source path (the full re-transcode reads from it).
  const originals = await prisma.storedFile.findMany({
    where: { entityType: 'VIDEO', fileRole: 'ORIGINAL', entityId: { in: candidates.map((v) => v.id) } },
    select: { entityId: true, storagePath: true },
  })
  const originalByVideo = new Map(originals.map((o) => [o.entityId, o.storagePath]))

  const todo = candidates.filter((v) => originalByVideo.has(v.id))
  const skippedNoOriginal = candidates.length - todo.length
  const slice = LIMIT ? todo.slice(0, LIMIT) : todo

  console.log(
    `[backfill-hls] ${todo.length} video(s) below HLS v${HLS_PACKAGE_VERSION}; enqueuing ${slice.length}` +
    `${skippedNoOriginal ? ` (${skippedNoOriginal} skipped — no ORIGINAL on file)` : ''}${DRY_RUN ? ' (dry run)' : ''}.`,
  )

  if (DRY_RUN) {
    for (const v of slice) console.log(`  would reprocess ${v.id} (project ${v.projectId})`)
  } else {
    const queue = getVideoQueue()
    let queued = 0
    for (const v of slice) {
      try {
        // No special flags → full reprocess: aligned re-transcode + thumbnail + timeline + HLS.
        await queue.add('process-video', { videoId: v.id, storagePath: originalByVideo.get(v.id)!, projectId: v.projectId })
        queued++
      } catch (err) {
        console.error(`  failed to enqueue ${v.id}:`, err)
      }
    }
    console.log(`[backfill-hls] enqueued ${queued} reprocess job(s).`)
  }

  // --- Video assets ---------------------------------------------------------
  // Video-type assets play via their own single-rendition HLS bundle. Heal any in
  // non-CLOSED projects that aren't marked ready (hlsReady false, or null for assets
  // predating the column). Re-running the asset preview job is self-normalising: if a
  // bundle already exists it early-returns and stamps hlsReady=true; otherwise it builds it.
  const assetCandidates = await prisma.videoAsset.findMany({
    where: {
      fileType: { startsWith: 'video/' },
      hlsReady: { not: true },
      video: { project: { status: { not: 'CLOSED' } } },
    },
    select: { id: true, fileType: true, fileName: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  })

  console.log(
    `[backfill-hls] ${assetCandidates.length} video asset(s) without a ready HLS bundle${DRY_RUN ? ' (dry run)' : ''}.`,
  )

  if (DRY_RUN) {
    for (const a of assetCandidates) console.log(`  would (re)build asset HLS ${a.id}`)
    return
  }

  let assetQueued = 0
  for (const a of assetCandidates) {
    try {
      // storagePath resolved from the StoredFile registry by the worker.
      await enqueueShareUploadPreview(
        { type: 'videoAsset', recordId: a.id, storagePath: '', fileType: a.fileType, fileName: a.fileName },
        { forceRequeue: true },
      )
      assetQueued++
    } catch (err) {
      console.error(`  failed to enqueue asset ${a.id}:`, err)
    }
  }
  console.log(`[backfill-hls] enqueued ${assetQueued} asset preview job(s).`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-hls] failed:', err)
    process.exit(1)
  })
