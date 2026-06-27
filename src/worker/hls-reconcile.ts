/**
 * HLS reconciliation sweep — the safeguard that makes HLS-only playback safe.
 *
 * Runs on a short repeat (see worker/index.ts). Two legs:
 *
 *  1. RETRY — find READY videos whose HLS bundle is missing/failed (hlsReady=false) and
 *     re-enqueue packaging. If the MP4 previews still exist it's a cheap `-c copy` remux
 *     (hlsOnly); if they're already gone it falls back to a full reprocess from the retained
 *     ORIGINAL. This is what recovers from a transient R2 500 with no manual intervention.
 *
 *  2. RECLAIM — for videos/assets whose HLS bundle is *verified complete* on storage, delete
 *     the now-redundant MP4 previews (HLS segments are a byte-identical remux of them). The
 *     verification is independent of the hlsReady flag — we re-walk the stored playlists — so
 *     a previously-misflagged bundle can never cause us to delete the only playable copy.
 *
 * Both legs are batch-capped and self-limiting: as bundles heal and previews are reclaimed,
 * the candidate sets shrink to empty on subsequent runs.
 */
import { prisma } from '@/lib/db'
import { getVideoQueue } from '@/lib/queue'
import { hlsStreamingEnabled } from '@/lib/video-stream-url'
import { verifyStoredHlsBundle } from './video-processor-helpers'
import { buildVideoHlsStorageRoot, buildVideoAssetHlsStorageRoot } from '@/lib/project-storage-paths'
import { deleteStoredFilesByCriteria } from '@/lib/stored-file'
import { deleteFile } from '@/lib/storage'
import {
  recalculateAndStoreProjectTotalBytes,
  recalculateAndStoreProjectPreviewBytes,
  recalculateAndStoreProjectDiskBytes,
} from '@/lib/project-total-bytes'
import type { FileRole } from '@prisma/client'

// Kill-switch for the reclaim leg: set HLS_RECLAIM_MP4_PREVIEWS=false to keep MP4 previews
// on disk even once HLS is verified (retry leg still runs). The packaging/retry safeguards
// are unconditional.
const RECLAIM_ENABLED = process.env.HLS_RECLAIM_MP4_PREVIEWS !== 'false'

// Legacy main-video MP4 previews (only exist on videos processed before direct-to-HLS).
const VIDEO_PREVIEW_ROLES: FileRole[] = ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080']
// Video-asset MP4 playback preview (still generated, then reclaimed once HLS verifies).
const ASSET_PREVIEW_ROLES: FileRole[] = ['PREVIEW_MP4']

// Per-run caps so a large backlog drains over several ticks instead of hammering storage.
const RETRY_BATCH = 100
const RECLAIM_BATCH = 200

export async function processHlsReconcile(): Promise<{
  requeued: number
  reclaimedVideos: number
  reclaimedAssets: number
}> {
  if (!hlsStreamingEnabled()) {
    return { requeued: 0, reclaimedVideos: 0, reclaimedAssets: 0 }
  }

  const requeued = await retryMissingVideoHls()
  let reclaimedVideos = 0
  let reclaimedAssets = 0
  if (RECLAIM_ENABLED) {
    const affectedProjects = new Set<string>()
    reclaimedVideos = await reclaimVideoPreviews(affectedProjects)
    reclaimedAssets = await reclaimAssetPreviews(affectedProjects)
    // Refresh derived storage totals once per touched project.
    for (const projectId of affectedProjects) {
      await Promise.allSettled([
        recalculateAndStoreProjectTotalBytes(projectId),
        recalculateAndStoreProjectPreviewBytes(projectId),
        recalculateAndStoreProjectDiskBytes(projectId),
      ])
    }
  }

  if (requeued || reclaimedVideos || reclaimedAssets) {
    console.log(
      `[HLS-RECONCILE] requeued=${requeued} reclaimedVideoPreviewSets=${reclaimedVideos} reclaimedAssetPreviews=${reclaimedAssets}`,
    )
  }
  return { requeued, reclaimedVideos, reclaimedAssets }
}

/**
 * Re-enqueue HLS packaging for READY videos that lack a ready bundle. The hlsOnly job
 * re-encodes the bundle directly from the retained ORIGINAL (there are no MP4 previews to
 * remux anymore), so a single path covers both fresh failures and reclaimed-preview videos.
 */
async function retryMissingVideoHls(): Promise<number> {
  const broken = await prisma.video.findMany({
    where: { status: 'READY', hlsReady: false },
    select: { id: true, projectId: true },
    take: RETRY_BATCH,
  })
  if (broken.length === 0) return 0

  let requeued = 0
  for (const v of broken) {
    // Deterministic jobId throttles re-enqueues: a still-pending/recently-finished job for
    // this video blocks a duplicate, so the sweep retries at most ~once per job-retention window.
    await getVideoQueue().add(
      'process-video',
      { videoId: v.id, projectId: v.projectId, storagePath: '', hlsOnly: true },
      { jobId: `hls-reconcile-${v.id}` },
    ).then(() => { requeued++ }).catch((e) => {
      console.warn(`[HLS-RECONCILE] hlsOnly enqueue failed for video ${v.id}:`, e instanceof Error ? e.message : e)
    })
  }
  return requeued
}

/** Delete MP4 previews for videos whose stored HLS bundle verifies complete. */
async function reclaimVideoPreviews(affectedProjects: Set<string>): Promise<number> {
  // Candidates: distinct videos that still have at least one MP4 preview row. Self-limiting —
  // once reclaimed they drop out of this set.
  const rows = await prisma.storedFile.findMany({
    where: { entityType: 'VIDEO', fileRole: { in: VIDEO_PREVIEW_ROLES } },
    select: { entityId: true, projectId: true },
    distinct: ['entityId'],
    take: RECLAIM_BATCH,
  })
  if (rows.length === 0) return 0

  let reclaimed = 0
  for (const row of rows) {
    const video = await prisma.video.findUnique({
      where: { id: row.entityId },
      select: { id: true, projectId: true, hlsReady: true, status: true },
    })
    if (!video || video.status !== 'READY' || !video.hlsReady) continue

    const projectId = video.projectId || row.projectId
    if (!projectId) continue

    const hlsRoot = buildVideoHlsStorageRoot(projectId, video.id)
    const verified = await verifyStoredHlsBundle(hlsRoot)
    if (!verified) continue

    const deleted = await deletePreviewSet('VIDEO', video.id, VIDEO_PREVIEW_ROLES)
    if (deleted) {
      affectedProjects.add(projectId)
      reclaimed++
    }
  }
  return reclaimed
}

/** Delete the redundant MP4 playback preview for assets whose stored HLS bundle verifies complete. */
async function reclaimAssetPreviews(affectedProjects: Set<string>): Promise<number> {
  const rows = await prisma.storedFile.findMany({
    where: { entityType: 'VIDEO_ASSET', fileRole: { in: ASSET_PREVIEW_ROLES } },
    select: { entityId: true, projectId: true },
    distinct: ['entityId'],
    take: RECLAIM_BATCH,
  })
  if (rows.length === 0) return 0

  let reclaimed = 0
  for (const row of rows) {
    const asset = await prisma.videoAsset.findUnique({
      where: { id: row.entityId },
      select: { id: true, videoId: true, video: { select: { projectId: true } } },
    })
    const projectId = asset?.video?.projectId || row.projectId
    if (!asset || !asset.videoId || !projectId) continue

    // Asset HLS readiness isn't a DB flag — it's the presence of a verified bundle.
    const hlsRoot = buildVideoAssetHlsStorageRoot(projectId, asset.videoId, asset.id)
    if (!(await verifyStoredHlsBundle(hlsRoot))) continue

    const deleted = await deletePreviewSet('VIDEO_ASSET', asset.id, ASSET_PREVIEW_ROLES)
    if (deleted) {
      affectedProjects.add(projectId)
      reclaimed++
    }
  }
  return reclaimed
}

/**
 * Delete a preview set from storage + the StoredFile registry. ORIGINAL is never touched.
 * Returns true when at least one file was removed.
 */
async function deletePreviewSet(
  entityType: 'VIDEO' | 'VIDEO_ASSET',
  entityId: string,
  roles: FileRole[],
): Promise<boolean> {
  const rows = await prisma.storedFile.findMany({
    where: { entityType, entityId, fileRole: { in: roles } },
    select: { storagePath: true },
  })
  if (rows.length === 0) return false

  await Promise.allSettled(rows.map((r) => deleteFile(r.storagePath)))
  await deleteStoredFilesByCriteria({ entityType, entityIds: [entityId], fileRoles: roles })
  return true
}
