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
import { getRedis } from '@/lib/redis'
import { getVideoQueue, getShareUploadPreviewQueue } from '@/lib/queue'
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

// A bundle that failed verification won't heal between sweeps on its own (the retry leg
// only re-packages hlsReady=false entities), so don't re-walk it against storage every
// 15 minutes. A false skip only delays reclaim — deletion always requires a fresh verify.
const VERIFY_FAIL_TTL_SECONDS = 4 * 3600

export async function processHlsReconcile(): Promise<{
  requeued: number
  requeuedAssets: number
  reclaimedVideos: number
  reclaimedAssets: number
}> {
  const requeued = await retryMissingVideoHls()
  const requeuedAssets = await retryMissingAssetHls()
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

  if (requeued || requeuedAssets || reclaimedVideos || reclaimedAssets) {
    console.log(
      `[HLS-RECONCILE] requeued=${requeued} requeuedAssets=${requeuedAssets} reclaimedVideoPreviewSets=${reclaimedVideos} reclaimedAssetPreviews=${reclaimedAssets}`,
    )
  }
  return { requeued, requeuedAssets, reclaimedVideos, reclaimedAssets }
}

/**
 * Re-enqueue HLS packaging for READY videos that lack a ready bundle. The hlsOnly job
 * re-encodes the bundle directly from the retained ORIGINAL (there are no MP4 previews to
 * remux anymore), so a single path covers both fresh failures and reclaimed-preview videos.
 */
async function retryMissingVideoHls(): Promise<number> {
  // Closed projects are excluded: their renditions may have been deliberately shed on
  // close (autoDeletePreviewsOnClose), so rebuilding HLS here would fight that intent.
  // Reopening a project makes its videos eligible for the retry again.
  const broken = await prisma.video.findMany({
    where: { status: 'READY', hlsReady: false, project: { status: { not: 'CLOSED' } } },
    select: { id: true, projectId: true },
    // Oldest-touched first so a large backlog rotates: a (re)processing attempt bumps the
    // row's updatedAt, moving it to the back so chronic failures can't starve the rest.
    orderBy: { updatedAt: 'asc' },
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

/**
 * Re-enqueue the asset-preview job for video assets whose HLS bundle is missing/failed
 * (hlsReady=false). The asset preview processor re-runs `maybePackageAssetHls`, which
 * re-encodes the bundle from the asset original (skipping the poster if it already exists).
 * hlsReady is null for non-video assets, so they're never selected. Closed projects are
 * excluded for the same reason as the video leg.
 */
async function retryMissingAssetHls(): Promise<number> {
  const broken = await prisma.videoAsset.findMany({
    where: { hlsReady: false, video: { project: { status: { not: 'CLOSED' } } } },
    select: { id: true, fileType: true, fileName: true },
    // Oldest-touched first so a large backlog rotates (see retryMissingVideoHls).
    orderBy: { updatedAt: 'asc' },
    take: RETRY_BATCH,
  })
  if (broken.length === 0) return 0

  let requeued = 0
  for (const a of broken) {
    // Add to the queue directly with a deterministic jobId (matching enqueueShareUploadPreview's
    // scheme) so a still-pending/recently-finished job blocks duplicates — throttling retries to
    // ~once per job-retention window, exactly like the video leg. We deliberately DON'T go through
    // enqueueShareUploadPreview here: it stamps previewStatus=PENDING + increments previewAttempts
    // BEFORE the dedup, which would churn a permanently-failing asset's state every sweep tick.
    // storagePath is resolved from the StoredFile registry by the worker.
    await getShareUploadPreviewQueue().add(
      'generate-preview',
      { type: 'videoAsset', recordId: a.id, storagePath: '', fileType: a.fileType, fileName: a.fileName },
      { jobId: `share-preview-videoAsset-${a.id}` },
    ).then(() => { requeued++ }).catch((e) => {
      console.warn(`[HLS-RECONCILE] asset HLS re-enqueue failed for ${a.id}:`, e instanceof Error ? e.message : e)
    })
  }
  return requeued
}

/**
 * Fetch the next window of reclaim candidates (distinct entities that still have at least
 * one MP4 preview row — self-limiting: once reclaimed they drop out of the set). A Redis
 * cursor rotates the scan window across sweeps so candidates that keep failing the checks
 * (not READY yet, bundle failing verification) can't pin the batch and starve the rest.
 */
async function nextReclaimCandidates(
  entityType: 'VIDEO' | 'VIDEO_ASSET',
  fileRoles: FileRole[],
): Promise<Array<{ entityId: string; projectId: string | null }>> {
  const redis = getRedis()
  const cursorKey = `hls_reclaim_cursor:${entityType}`
  const cursor = await redis.get(cursorKey).catch(() => null)

  const rows = await prisma.storedFile.findMany({
    where: {
      entityType,
      fileRole: { in: fileRoles },
      ...(cursor ? { entityId: { gt: cursor } } : {}),
    },
    select: { entityId: true, projectId: true },
    distinct: ['entityId'],
    orderBy: { entityId: 'asc' },
    take: RECLAIM_BATCH,
  })

  // A short page means the scan reached the end of the set — wrap to the start next sweep.
  if (rows.length < RECLAIM_BATCH) {
    await redis.del(cursorKey).catch(() => {})
  } else {
    await redis.set(cursorKey, rows[rows.length - 1].entityId).catch(() => {})
  }
  return rows
}

/** True when this bundle failed verification recently — skip re-walking it against storage. */
async function verifyFailedRecently(entityType: 'VIDEO' | 'VIDEO_ASSET', entityId: string): Promise<boolean> {
  return Boolean(await getRedis().get(`hls_verify_failed:${entityType}:${entityId}`).catch(() => null))
}

async function markVerifyFailed(entityType: 'VIDEO' | 'VIDEO_ASSET', entityId: string): Promise<void> {
  await getRedis().set(`hls_verify_failed:${entityType}:${entityId}`, '1', 'EX', VERIFY_FAIL_TTL_SECONDS).catch(() => {})
}

/** Delete MP4 previews for videos whose stored HLS bundle verifies complete. */
async function reclaimVideoPreviews(affectedProjects: Set<string>): Promise<number> {
  const rows = await nextReclaimCandidates('VIDEO', VIDEO_PREVIEW_ROLES)
  if (rows.length === 0) return 0

  const videos = await prisma.video.findMany({
    where: { id: { in: rows.map((r) => r.entityId) }, status: 'READY', hlsReady: true },
    select: { id: true, projectId: true },
  })
  const fallbackProjectId = new Map(rows.map((r) => [r.entityId, r.projectId]))

  let reclaimed = 0
  for (const video of videos) {
    const projectId = video.projectId || fallbackProjectId.get(video.id)
    if (!projectId) continue

    if (await verifyFailedRecently('VIDEO', video.id)) continue

    const hlsRoot = buildVideoHlsStorageRoot(projectId, video.id)
    const verified = await verifyStoredHlsBundle(hlsRoot)
    if (!verified) {
      await markVerifyFailed('VIDEO', video.id)
      continue
    }

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
  const rows = await nextReclaimCandidates('VIDEO_ASSET', ASSET_PREVIEW_ROLES)
  if (rows.length === 0) return 0

  const assets = await prisma.videoAsset.findMany({
    where: { id: { in: rows.map((r) => r.entityId) } },
    select: { id: true, videoId: true, video: { select: { projectId: true } } },
  })
  const fallbackProjectId = new Map(rows.map((r) => [r.entityId, r.projectId]))

  let reclaimed = 0
  for (const asset of assets) {
    const projectId = asset.video?.projectId || fallbackProjectId.get(asset.id)
    if (!asset.videoId || !projectId) continue

    if (await verifyFailedRecently('VIDEO_ASSET', asset.id)) continue

    // Verify the bundle on storage rather than trusting the `hlsReady` flag — reclaim
    // deletes the MP4, so we must be certain the HLS copy is actually complete first.
    const hlsRoot = buildVideoAssetHlsStorageRoot(projectId, asset.videoId, asset.id)
    if (!(await verifyStoredHlsBundle(hlsRoot))) {
      await markVerifyFailed('VIDEO_ASSET', asset.id)
      continue
    }

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
