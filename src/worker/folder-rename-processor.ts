import { Job } from 'bullmq'
import path from 'path'
import { FolderRenameJobPayload } from '../lib/queue'
import { prisma } from '../lib/db'
import { isS3Mode, s3MoveDirectoryWithProgress, s3MoveFile } from '../lib/s3-storage'
import { getAlbumZipFileName } from '../lib/album-photo-zip'
import { renameStoredPaths, type EntityType } from '../lib/stored-file'

// ---------------------------------------------------------------------------
// StoredFile path rebase helper — mirrors the legacy raw-SQL UPDATEs but
// operates on the StoredFile registry, the future single source of truth.
// ---------------------------------------------------------------------------

/**
 * Rename StoredFile paths for all entity types within a project.
 * Covers VIDEO, VIDEO_ASSET, ALBUM_PHOTO, ALBUM (ZIPs), and simple single-file entities.
 */
async function renameStoredFilesForProject(
  projectId: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  const [videoIds, albumIds, projectEmailIds, projectFileIds, commentFileIds, shareUploadFileIds] = await Promise.all([
    prisma.video.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(v => v.id)),
    prisma.album.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(a => a.id)),
    prisma.projectEmail.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(e => e.id)),
    prisma.projectFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id)),
    prisma.commentFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id)),
    prisma.shareUploadFile.findMany({ where: { projectId }, select: { id: true } }).then(r => r.map(f => f.id)),
  ])

  const assetIds = videoIds.length > 0
    ? await prisma.videoAsset.findMany({ where: { videoId: { in: videoIds } }, select: { id: true } }).then(r => r.map(a => a.id))
    : [] as string[]

  const photoIds = albumIds.length > 0
    ? await prisma.albumPhoto.findMany({ where: { albumId: { in: albumIds } }, select: { id: true } }).then(r => r.map(p => p.id))
    : [] as string[]

  const emailAttachmentIds = projectEmailIds.length > 0
    ? await prisma.projectEmailAttachment.findMany({ where: { projectEmailId: { in: projectEmailIds } }, select: { id: true } }).then(r => r.map(a => a.id))
    : [] as string[]

  const renames: Array<{ entityType: EntityType; entityIds: string[] }> = [
    { entityType: 'VIDEO', entityIds: videoIds },
    { entityType: 'VIDEO_ASSET', entityIds: assetIds },
    { entityType: 'ALBUM', entityIds: albumIds },
    { entityType: 'ALBUM_PHOTO', entityIds: photoIds },
    { entityType: 'SHARE_UPLOAD_FILE', entityIds: shareUploadFileIds },
    { entityType: 'PROJECT_FILE', entityIds: projectFileIds },
    { entityType: 'COMMENT_FILE', entityIds: commentFileIds },
    { entityType: 'PROJECT_EMAIL', entityIds: projectEmailIds },
    { entityType: 'PROJECT_EMAIL_ATTACHMENT', entityIds: emailAttachmentIds },
  ]

  for (const { entityType, entityIds } of renames) {
    if (entityIds.length > 0) {
      await renameStoredPaths(entityType, entityIds, oldPrefix, newPrefix)
    }
  }
}

// ---------------------------------------------------------------------------
// Progress throttle: update DB at most every N ms to avoid hammering the DB
// on high-object-count renames.
// ---------------------------------------------------------------------------
const PROGRESS_UPDATE_INTERVAL_MS = 4_000

// ---------------------------------------------------------------------------
// DB path replacement helpers (mirrors logic in project and client PATCH routes)
// ---------------------------------------------------------------------------

async function updateProjectDbPaths(
  projectId: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  // Legacy path columns have been dropped — all path rebasing is now handled
  // by renameStoredPaths() above. Only folder-root columns remain.
  await prisma.project.update({
    where: { id: projectId },
    data: { storagePath: newPrefix },
  })
}

async function updateClientDbPaths(
  clientId: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  // Legacy path columns have been dropped — all path rebasing is now handled
  // by renameStoredPaths() (called per project in processFolderRename).
  await prisma.$executeRaw`
    UPDATE "Project"
    SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
    WHERE "clientId" = ${clientId}
  `
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export async function processFolderRename(job: Job<FolderRenameJobPayload>): Promise<void> {
  const { folderRenameJobId } = job.data

  if (!isS3Mode()) {
    console.error(`[FOLDER-RENAME] Job ${folderRenameJobId} started but S3 mode is not active — skipping`)
    return
  }

  const renameJob = await prisma.folderRenameJob.findUnique({ where: { id: folderRenameJobId } })
  if (!renameJob) {
    console.error(`[FOLDER-RENAME] Job ${folderRenameJobId} not found in DB`)
    return
  }

  if (renameJob.status === 'COMPLETED') {
    console.log(`[FOLDER-RENAME] Job ${folderRenameJobId} already completed — skipping`)
    return
  }

  console.log(`[FOLDER-RENAME] Starting job ${folderRenameJobId}: ${renameJob.oldPrefix} → ${renameJob.newPrefix}`)

  await prisma.folderRenameJob.update({
    where: { id: folderRenameJobId },
    data: { status: 'IN_PROGRESS' },
  })

  try {
    let lastProgressUpdate = 0

    await s3MoveDirectoryWithProgress(
      renameJob.oldPrefix,
      renameJob.newPrefix,
      async (copiedObjects, totalObjects, copiedBytes, totalBytes) => {
        const now = Date.now()

        // Update DB totals on first callback and then throttled
        if (copiedObjects === 1 || now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL_MS) {
          await prisma.folderRenameJob.update({
            where: { id: folderRenameJobId },
            data: { copiedObjects, totalObjects, copiedBytes, totalBytes },
          })
          lastProgressUpdate = now
        }
      },
    )

    // Update DB storage paths
    if (renameJob.entityType === 'PROJECT') {
      await updateProjectDbPaths(renameJob.entityId, renameJob.oldPrefix, renameJob.newPrefix)
      await renameStoredFilesForProject(renameJob.entityId, renameJob.oldPrefix, renameJob.newPrefix)
    } else if (renameJob.entityType === 'CLIENT') {
      await updateClientDbPaths(renameJob.entityId, renameJob.oldPrefix, renameJob.newPrefix)

      // Rename StoredFile paths for all projects under this client
      const clientProjectIds = await prisma.project.findMany({
        where: { clientId: renameJob.entityId },
        select: { id: true },
      }).then(r => r.map(p => p.id))
      for (const pid of clientProjectIds) {
        await renameStoredFilesForProject(pid, renameJob.oldPrefix, renameJob.newPrefix)
      }
      // Also rename client files
      const clientFileIds = await prisma.clientFile.findMany({
        where: { clientId: renameJob.entityId },
        select: { id: true },
      }).then(r => r.map(f => f.id))
      if (clientFileIds.length > 0) {
        await renameStoredPaths('CLIENT_FILE', clientFileIds, renameJob.oldPrefix, renameJob.newPrefix)
      }
    } else if (renameJob.entityType === 'VIDEO_GROUP') {
      // entityId = projectId; update video + asset paths for this folder only
      const projectPrefix = path.posix.dirname(path.posix.dirname(renameJob.oldPrefix))
      const oldFolderName = path.posix.basename(renameJob.oldPrefix)
      const newFolderName = path.posix.basename(renameJob.newPrefix)
      const oldPreviewPrefix = `${projectPrefix}/.previews/videos/${oldFolderName}`
      const newPreviewPrefix = `${projectPrefix}/.previews/videos/${newFolderName}`

      // Move the .previews/videos/{folder} prefix (non-fatal if absent)
      try {
        await s3MoveDirectoryWithProgress(oldPreviewPrefix, newPreviewPrefix, async () => {})
      } catch (previewMoveError) {
        console.warn(`[FOLDER-RENAME] Job ${folderRenameJobId}: video group previews move failed (non-fatal):`, previewMoveError)
      }

      await prisma.$executeRaw`
        UPDATE "Video"
        SET "storageFolderName" = ${renameJob.entityName}
        WHERE "projectId" = ${renameJob.entityId}
          AND "storageFolderName" = ${oldFolderName}
      `

      // Rename StoredFile paths for affected videos and assets
      // Find affected videos via StoredFile registry (originalStoragePath column dropped)
      const sfVideos = await prisma.storedFile.findMany({
        where: { entityType: 'VIDEO', fileRole: 'ORIGINAL', storagePath: { startsWith: renameJob.oldPrefix } },
        select: { entityId: true },
      })
      const vgVideoIds = sfVideos.map(s => s.entityId)
      const vgAssetIds = vgVideoIds.length > 0
        ? await prisma.videoAsset.findMany({ where: { videoId: { in: vgVideoIds } }, select: { id: true } }).then(r => r.map(a => a.id))
        : []
      if (vgVideoIds.length > 0) await renameStoredPaths('VIDEO', vgVideoIds, renameJob.oldPrefix, renameJob.newPrefix)
      if (vgAssetIds.length > 0) await renameStoredPaths('VIDEO_ASSET', vgAssetIds, renameJob.oldPrefix, renameJob.newPrefix)
    } else if (renameJob.entityType === 'ALBUM') {
      // entityId = albumId; update album + photo paths
      // oldPrefix / newPrefix = {proj}/albums/{folder}
      const projectStoragePath = path.posix.dirname(path.posix.dirname(renameJob.oldPrefix))
      const oldAlbumFolder = path.posix.basename(renameJob.oldPrefix)
      const newAlbumFolder = path.posix.basename(renameJob.newPrefix)
      const oldAlbumPreviewsPrefix = `${projectStoragePath}/.previews/albums/${oldAlbumFolder}`
      const newAlbumPreviewsPrefix = `${projectStoragePath}/.previews/albums/${newAlbumFolder}`

      // Move the .previews/albums/{folder} prefix (non-fatal if absent)
      try {
        await s3MoveDirectoryWithProgress(oldAlbumPreviewsPrefix, newAlbumPreviewsPrefix, async () => {})
      } catch (previewMoveError) {
        console.warn(`[FOLDER-RENAME] Job ${folderRenameJobId}: album previews move failed (non-fatal):`, previewMoveError)
      }

      await prisma.$executeRaw`
        UPDATE "Album"
        SET "storageFolderName" = ${renameJob.entityName}
        WHERE "id" = ${renameJob.entityId}
      `

      // Rename StoredFile paths for album photos and album ZIPs
      const albumPhotoIds = await prisma.albumPhoto.findMany({
        where: { albumId: renameJob.entityId },
        select: { id: true },
      }).then(r => r.map(p => p.id))
      if (albumPhotoIds.length > 0) {
        await renameStoredPaths('ALBUM_PHOTO', albumPhotoIds, renameJob.oldPrefix, renameJob.newPrefix)
      }
      await renameStoredPaths('ALBUM', [renameJob.entityId], renameJob.oldPrefix, renameJob.newPrefix)

      // Rename the zip files inside the (now-moved) zips/ subdirectory.
      // The zip filename encodes the album display name, so a prefix copy alone is not enough.
      if (renameJob.oldEntityName) {
        const album = await prisma.album.findUnique({
          where: { id: renameJob.entityId },
          select: { name: true },
        })
        if (album) {
          const zipsDir = `${renameJob.newPrefix}/zips`
          for (const variant of ['full', 'social'] as const) {
            const oldZipPath = `${zipsDir}/${getAlbumZipFileName({ albumName: renameJob.oldEntityName, variant })}`
            const newZipPath = `${zipsDir}/${getAlbumZipFileName({ albumName: album.name, variant })}`
            if (oldZipPath !== newZipPath) {
              try {
                await s3MoveFile(oldZipPath, newZipPath)
              } catch (zipMoveError) {
                console.warn(`[FOLDER-RENAME] Job ${folderRenameJobId}: ${variant} zip rename failed (non-fatal):`, zipMoveError)
              }
            }
          }
        }
      }
    } else if (renameJob.entityType === 'VIDEO_VERSION') {
      // entityId = videoId; entityName = new version label
      // Derive the previews-root prefix from the main prefix:
      //   oldPrefix = {projectStoragePath}/videos/{videoFolderName}/{oldVersionLabel}
      //   oldPreviewPrefix = {projectStoragePath}/.previews/videos/{videoFolderName}/{oldVersionLabel}
      const videoFolderName = path.posix.basename(path.posix.dirname(renameJob.oldPrefix))
      const projectStoragePath = path.posix.dirname(path.posix.dirname(path.posix.dirname(renameJob.oldPrefix)))
      const oldVersionLabelFolder = path.posix.basename(renameJob.oldPrefix)
      const newVersionLabelFolder = path.posix.basename(renameJob.newPrefix)
      const oldPreviewPrefix = `${projectStoragePath}/.previews/videos/${videoFolderName}/${oldVersionLabelFolder}`
      const newPreviewPrefix = `${projectStoragePath}/.previews/videos/${videoFolderName}/${newVersionLabelFolder}`

      // Move the previews folder (no-ops silently if no preview objects exist yet).
      try {
        await s3MoveDirectoryWithProgress(oldPreviewPrefix, newPreviewPrefix, async () => {})
      } catch (previewMoveError) {
        console.warn(`[FOLDER-RENAME] Job ${folderRenameJobId}: previews move failed (non-fatal):`, previewMoveError)
      }

      // Rename StoredFile paths for this video and its assets
      await renameStoredPaths('VIDEO', [renameJob.entityId], renameJob.oldPrefix, renameJob.newPrefix)
      const vvAssetIds = await prisma.videoAsset.findMany({
        where: { videoId: renameJob.entityId },
        select: { id: true },
      }).then(r => r.map(a => a.id))
      if (vvAssetIds.length > 0) {
        await renameStoredPaths('VIDEO_ASSET', vvAssetIds, renameJob.oldPrefix, renameJob.newPrefix)
      }
    }

    // Mark complete (final progress values will be consistent with totalObjects)
    const finalJob = await prisma.folderRenameJob.findUnique({ where: { id: folderRenameJobId } })
    await prisma.folderRenameJob.update({
      where: { id: folderRenameJobId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        // Ensure displayed progress is 100%
        copiedObjects: finalJob?.totalObjects ?? finalJob?.copiedObjects ?? 0,
        copiedBytes: finalJob?.totalBytes ?? finalJob?.copiedBytes ?? BigInt(0),
      },
    })

    console.log(`[FOLDER-RENAME] Job ${folderRenameJobId} completed successfully`)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error(`[FOLDER-RENAME] Job ${folderRenameJobId} failed:`, errMsg)

    await prisma.folderRenameJob.update({
      where: { id: folderRenameJobId },
      data: {
        status: 'FAILED',
        error: errMsg,
        completedAt: new Date(),
      },
    })

    // Re-throw so BullMQ marks the job as failed too
    throw error
  }
}
