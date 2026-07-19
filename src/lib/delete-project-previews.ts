/**
 * Shared "shed the heavy playable renditions" logic for a project, used by every
 * close-path that deletes previews (manual close via the project API, the auto-close
 * worker) so their semantics can't drift.
 *
 * Deletes the HLS bundles (the playable rendition since direct-to-HLS) plus any legacy
 * MP4 previews and the video-asset playback MP4, keeping everything needed to still
 * browse the FILES area after close: video THUMBNAIL, timeline sprites/VTT, and the
 * video-asset still image (PREVIEW_IMAGE). The HLS-reconcile/backfill sweeps skip
 * CLOSED projects, so they won't immediately rebuild what we delete here; reopening
 * a project makes its videos eligible for regeneration again.
 */

import { prisma } from './db'
import { deleteFile, deleteDirectory } from './storage'
import { getStoredFileRecords, deleteStoredFilesByCriteria, deleteStoredFilesByIds } from './stored-file'
import { buildVideoHlsStorageRoot, buildVideoAssetHlsStorageRoot } from './project-storage-paths'
import {
  recalculateAndStoreProjectDiskBytes,
  recalculateAndStoreProjectPreviewBytes,
  recalculateAndStoreProjectTotalBytes,
} from './project-total-bytes'

const VIDEO_PREVIEW_ROLES = ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080'] as const
const ASSET_PREVIEW_ROLES = ['PREVIEW_MP4'] as const
const HLS_ROLES = ['HLS_PLAYLIST', 'HLS_SEGMENTS'] as const

export interface DeleteProjectPreviewsResult {
  /** Individual preview files (legacy MP4 previews + asset playback MP4s) deleted. */
  deletedPreviewFiles: number
  /** Videos whose HLS bundle directory was deleted. */
  deletedVideoHlsBundles: number
  /** Video assets whose HLS bundle directory was deleted. */
  deletedAssetHlsBundles: number
}

export async function deleteProjectPreviews(
  projectId: string,
  { logPrefix = 'DELETE-PREVIEWS' }: { logPrefix?: string } = {}
): Promise<DeleteProjectPreviewsResult> {
  // Get all video IDs (and their asset IDs) for this project
  const videos = await prisma.video.findMany({
    where: { projectId },
    select: { id: true },
  })
  const videoIds = videos.map(v => v.id)
  const assets = await prisma.videoAsset.findMany({
    where: { video: { projectId } },
    select: { id: true, videoId: true },
  })
  const videoAssetIds = assets.map(a => a.id)

  // Resolve preview rows via the StoredFile registry (id needed so we drop only the
  // rows whose file actually deletes, not all of them unconditionally).
  const [videoFiles, assetFiles] = await Promise.all([
    videoIds.length > 0
      ? getStoredFileRecords('VIDEO', videoIds, { fileRoles: [...VIDEO_PREVIEW_ROLES], select: { id: true, storagePath: true } })
      : [],
    videoAssetIds.length > 0
      ? getStoredFileRecords('VIDEO_ASSET', videoAssetIds, { fileRoles: [...ASSET_PREVIEW_ROLES], select: { id: true, storagePath: true } })
      : [],
  ])

  // Delete each preview file; keep its row if the delete failed so a later run can
  // retry instead of orphaning the file. (Storage deletes no-op on already-missing
  // paths, so "already gone" counts as success and the row is dropped.)
  const deletedPreviewIds: string[] = []
  await Promise.allSettled(
    [...videoFiles, ...assetFiles].map(async (f) => {
      try {
        await deleteFile(f.storagePath)
        deletedPreviewIds.push(f.id as string)
      } catch (e) {
        console.error(`[${logPrefix}] Failed to delete preview ${f.storagePath} (project ${projectId}):`, e)
      }
    })
  )
  if (deletedPreviewIds.length > 0) {
    await deleteStoredFilesByIds(deletedPreviewIds)
  }

  // Shed the HLS bundles — the actual heavy rendition since direct-to-HLS. Each bundle
  // is a directory (master playlist + init + segments); delete the whole HLS root and,
  // only for the entities whose delete succeeded, drop the StoredFile rows + clear
  // hlsReady (a failed delete keeps the row so reopen/reconcile can retry). ORIGINAL/
  // thumbnail/sprites stay.
  const deletedVideoHlsIds: string[] = []
  const deletedAssetHlsIds: string[] = []
  await Promise.allSettled([
    ...videos.map(async (v) => {
      try {
        await deleteDirectory(buildVideoHlsStorageRoot(projectId, v.id))
        deletedVideoHlsIds.push(v.id)
      } catch (e) {
        console.error(`[${logPrefix}] Failed to delete HLS bundle for video ${v.id} (project ${projectId}):`, e)
      }
    }),
    ...assets
      .filter(a => a.videoId)
      .map(async (a) => {
        try {
          await deleteDirectory(buildVideoAssetHlsStorageRoot(projectId, a.videoId, a.id))
          deletedAssetHlsIds.push(a.id)
        } catch (e) {
          console.error(`[${logPrefix}] Failed to delete HLS bundle for asset ${a.id} (project ${projectId}):`, e)
        }
      }),
  ])
  if (deletedVideoHlsIds.length > 0) {
    await deleteStoredFilesByCriteria({ entityType: 'VIDEO', entityIds: deletedVideoHlsIds, fileRoles: [...HLS_ROLES] })
    // The bundle is gone — reflect that so the FILES/admin UI and any future
    // (post-reopen) reconcile see the video as needing HLS rather than ready.
    await prisma.video.updateMany({ where: { id: { in: deletedVideoHlsIds } }, data: { hlsReady: false } })
  }
  if (deletedAssetHlsIds.length > 0) {
    await deleteStoredFilesByCriteria({ entityType: 'VIDEO_ASSET', entityIds: deletedAssetHlsIds, fileRoles: [...HLS_ROLES] })
    // Mark video assets that had a bundle as not-ready (only those currently true —
    // leaves non-video assets at NULL). Reopen/reconcile will rebuild them.
    await prisma.videoAsset.updateMany({ where: { id: { in: deletedAssetHlsIds }, hlsReady: true }, data: { hlsReady: false } })
  }

  // Refresh precomputed storage totals so freed space shows up immediately
  // instead of waiting for the daily reconcile job.
  await Promise.allSettled([
    recalculateAndStoreProjectTotalBytes(projectId),
    recalculateAndStoreProjectPreviewBytes(projectId),
    recalculateAndStoreProjectDiskBytes(projectId),
  ])

  return {
    deletedPreviewFiles: deletedPreviewIds.length,
    deletedVideoHlsBundles: deletedVideoHlsIds.length,
    deletedAssetHlsBundles: deletedAssetHlsIds.length,
  }
}
