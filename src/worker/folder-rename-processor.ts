import { Job } from 'bullmq'
import path from 'path'
import { FolderRenameJobPayload } from '../lib/queue'
import { prisma } from '../lib/db'
import { isS3Mode, s3MoveDirectoryWithProgress } from '../lib/s3-storage'

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
  await prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: projectId },
      data: { storagePath: newPrefix },
    })

    // Use raw SQL so Prisma's @updatedAt auto-touch is bypassed — prevents
    // READY videos from reappearing in the "Processing complete" running-jobs list.
    await tx.$executeRaw`
      UPDATE "Video"
      SET
        "originalStoragePath" = REPLACE("originalStoragePath", ${oldPrefix}, ${newPrefix}),
        "preview480Path"      = CASE WHEN "preview480Path"      IS NULL THEN NULL ELSE REPLACE("preview480Path",      ${oldPrefix}, ${newPrefix}) END,
        "preview720Path"      = CASE WHEN "preview720Path"      IS NULL THEN NULL ELSE REPLACE("preview720Path",      ${oldPrefix}, ${newPrefix}) END,
        "preview1080Path"     = CASE WHEN "preview1080Path"     IS NULL THEN NULL ELSE REPLACE("preview1080Path",     ${oldPrefix}, ${newPrefix}) END,
        "thumbnailPath"       = CASE WHEN "thumbnailPath"       IS NULL THEN NULL ELSE REPLACE("thumbnailPath",       ${oldPrefix}, ${newPrefix}) END,
        "timelinePreviewVttPath"     = CASE WHEN "timelinePreviewVttPath"     IS NULL THEN NULL ELSE REPLACE("timelinePreviewVttPath",     ${oldPrefix}, ${newPrefix}) END,
        "timelinePreviewSpritesPath" = CASE WHEN "timelinePreviewSpritesPath" IS NULL THEN NULL ELSE REPLACE("timelinePreviewSpritesPath", ${oldPrefix}, ${newPrefix}) END
      WHERE "projectId" = ${projectId}
    `

    await tx.$executeRaw`
      UPDATE "VideoAsset"
      SET
        "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix}),
        "previewPath" = CASE WHEN "previewPath" IS NULL THEN NULL ELSE REPLACE("previewPath", ${oldPrefix}, ${newPrefix}) END
      WHERE "videoId" IN (SELECT "id" FROM "Video" WHERE "projectId" = ${projectId})
    `

    await tx.$executeRaw`
      UPDATE "AlbumPhoto"
      SET
        "storagePath"       = REPLACE("storagePath",       ${oldPrefix}, ${newPrefix}),
        "socialStoragePath" = CASE WHEN "socialStoragePath" IS NULL THEN NULL ELSE REPLACE("socialStoragePath", ${oldPrefix}, ${newPrefix}) END,
        "thumbnailStoragePath" = CASE WHEN "thumbnailStoragePath" IS NULL THEN NULL ELSE REPLACE("thumbnailStoragePath", ${oldPrefix}, ${newPrefix}) END
      WHERE "albumId" IN (SELECT "id" FROM "Album" WHERE "projectId" = ${projectId})
    `

    await tx.$executeRaw`
      UPDATE "ProjectFile"
      SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
      WHERE "projectId" = ${projectId}
    `

    await tx.$executeRaw`
      UPDATE "ProjectEmail"
      SET "rawStoragePath" = REPLACE("rawStoragePath", ${oldPrefix}, ${newPrefix})
      WHERE "projectId" = ${projectId}
    `

    await tx.$executeRaw`
      UPDATE "ProjectEmailAttachment"
      SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
      WHERE "projectEmailId" IN (SELECT "id" FROM "ProjectEmail" WHERE "projectId" = ${projectId})
    `

    await tx.$executeRaw`
      UPDATE "CommentFile"
      SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
      WHERE "projectId" = ${projectId}
    `
  })
}

async function updateClientDbPaths(
  clientId: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "Project"
      SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
      WHERE "clientId" = ${clientId}
    `

    await tx.$executeRaw`
      UPDATE "ClientFile"
      SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
      WHERE "clientId" = ${clientId}
    `

    await tx.$executeRaw`
      UPDATE "Video"
      SET
        "originalStoragePath" = REPLACE("originalStoragePath", ${oldPrefix}, ${newPrefix}),
        "preview480Path"      = CASE WHEN "preview480Path"      IS NULL THEN NULL ELSE REPLACE("preview480Path",      ${oldPrefix}, ${newPrefix}) END,
        "preview720Path"      = CASE WHEN "preview720Path"      IS NULL THEN NULL ELSE REPLACE("preview720Path",      ${oldPrefix}, ${newPrefix}) END,
        "preview1080Path"     = CASE WHEN "preview1080Path"     IS NULL THEN NULL ELSE REPLACE("preview1080Path",     ${oldPrefix}, ${newPrefix}) END,
        "thumbnailPath"       = CASE WHEN "thumbnailPath"       IS NULL THEN NULL ELSE REPLACE("thumbnailPath",       ${oldPrefix}, ${newPrefix}) END,
        "timelinePreviewVttPath"     = CASE WHEN "timelinePreviewVttPath"     IS NULL THEN NULL ELSE REPLACE("timelinePreviewVttPath",     ${oldPrefix}, ${newPrefix}) END,
        "timelinePreviewSpritesPath" = CASE WHEN "timelinePreviewSpritesPath" IS NULL THEN NULL ELSE REPLACE("timelinePreviewSpritesPath", ${oldPrefix}, ${newPrefix}) END
      WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "clientId" = ${clientId})
    `

    await tx.$executeRaw`
      UPDATE "VideoAsset"
      SET
        "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix}),
        "previewPath" = CASE WHEN "previewPath" IS NULL THEN NULL ELSE REPLACE("previewPath", ${oldPrefix}, ${newPrefix}) END
      WHERE "videoId" IN (
        SELECT "id" FROM "Video"
        WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "clientId" = ${clientId})
      )
    `

    await tx.$executeRaw`
      UPDATE "AlbumPhoto"
      SET
        "storagePath"       = REPLACE("storagePath",       ${oldPrefix}, ${newPrefix}),
        "socialStoragePath" = CASE WHEN "socialStoragePath" IS NULL THEN NULL ELSE REPLACE("socialStoragePath", ${oldPrefix}, ${newPrefix}) END,
        "thumbnailStoragePath" = CASE WHEN "thumbnailStoragePath" IS NULL THEN NULL ELSE REPLACE("thumbnailStoragePath", ${oldPrefix}, ${newPrefix}) END
      WHERE "albumId" IN (
        SELECT "id" FROM "Album"
        WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "clientId" = ${clientId})
      )
    `

    await tx.$executeRaw`
      UPDATE "ProjectFile"
      SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
      WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "clientId" = ${clientId})
    `

    await tx.$executeRaw`
      UPDATE "ProjectEmail"
      SET "rawStoragePath" = REPLACE("rawStoragePath", ${oldPrefix}, ${newPrefix})
      WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "clientId" = ${clientId})
    `

    await tx.$executeRaw`
      UPDATE "ProjectEmailAttachment"
      SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
      WHERE "projectEmailId" IN (
        SELECT "id" FROM "ProjectEmail"
        WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "clientId" = ${clientId})
      )
    `

    await tx.$executeRaw`
      UPDATE "CommentFile"
      SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
      WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "clientId" = ${clientId})
    `
  })
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
    } else if (renameJob.entityType === 'CLIENT') {
      await updateClientDbPaths(renameJob.entityId, renameJob.oldPrefix, renameJob.newPrefix)
    } else if (renameJob.entityType === 'VIDEO_GROUP') {
      // entityId = projectId; update video + asset paths for this folder only
      const projectPrefix = path.posix.dirname(path.posix.dirname(renameJob.oldPrefix))
      const oldFolderName = path.posix.basename(renameJob.oldPrefix)
      const newFolderName = path.posix.basename(renameJob.newPrefix)
      const oldPreviewPrefix = `${projectPrefix}/.previews/videos/${oldFolderName}`
      const newPreviewPrefix = `${projectPrefix}/.previews/videos/${newFolderName}`

      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "Video"
          SET
            "storageFolderName" = ${renameJob.entityName},
            "originalStoragePath" = REPLACE("originalStoragePath", ${renameJob.oldPrefix}, ${renameJob.newPrefix}),
            "preview480Path"      = CASE WHEN "preview480Path"      IS NULL THEN NULL ELSE REPLACE(REPLACE("preview480Path",      ${renameJob.oldPrefix}, ${renameJob.newPrefix}), ${oldPreviewPrefix}, ${newPreviewPrefix}) END,
            "preview720Path"      = CASE WHEN "preview720Path"      IS NULL THEN NULL ELSE REPLACE(REPLACE("preview720Path",      ${renameJob.oldPrefix}, ${renameJob.newPrefix}), ${oldPreviewPrefix}, ${newPreviewPrefix}) END,
            "preview1080Path"     = CASE WHEN "preview1080Path"     IS NULL THEN NULL ELSE REPLACE(REPLACE("preview1080Path",     ${renameJob.oldPrefix}, ${renameJob.newPrefix}), ${oldPreviewPrefix}, ${newPreviewPrefix}) END,
            "thumbnailPath"       = CASE WHEN "thumbnailPath"       IS NULL THEN NULL ELSE REPLACE(REPLACE("thumbnailPath",       ${renameJob.oldPrefix}, ${renameJob.newPrefix}), ${oldPreviewPrefix}, ${newPreviewPrefix}) END,
            "timelinePreviewVttPath"     = CASE WHEN "timelinePreviewVttPath"     IS NULL THEN NULL ELSE REPLACE(REPLACE("timelinePreviewVttPath",     ${renameJob.oldPrefix}, ${renameJob.newPrefix}), ${oldPreviewPrefix}, ${newPreviewPrefix}) END,
            "timelinePreviewSpritesPath" = CASE WHEN "timelinePreviewSpritesPath" IS NULL THEN NULL ELSE REPLACE(REPLACE("timelinePreviewSpritesPath", ${renameJob.oldPrefix}, ${renameJob.newPrefix}), ${oldPreviewPrefix}, ${newPreviewPrefix}) END
          WHERE "projectId" = ${renameJob.entityId}
            AND "originalStoragePath" LIKE ${renameJob.oldPrefix + '%'}
        `
        await tx.$executeRaw`
          UPDATE "VideoAsset"
          SET
            "storagePath" = REPLACE("storagePath", ${renameJob.oldPrefix}, ${renameJob.newPrefix}),
            "previewPath" = CASE WHEN "previewPath" IS NULL THEN NULL ELSE REPLACE(REPLACE("previewPath", ${renameJob.oldPrefix}, ${renameJob.newPrefix}), ${oldPreviewPrefix}, ${newPreviewPrefix}) END
          WHERE "storagePath" LIKE ${renameJob.oldPrefix + '%'}
        `
      })
    } else if (renameJob.entityType === 'ALBUM') {
      // entityId = albumId; update album + photo paths
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "Album"
          SET "storageFolderName" = ${renameJob.entityName}
          WHERE "id" = ${renameJob.entityId}
        `
        await tx.$executeRaw`
          UPDATE "AlbumPhoto"
          SET
            "storagePath"       = REPLACE("storagePath",       ${renameJob.oldPrefix}, ${renameJob.newPrefix}),
            "socialStoragePath" = CASE WHEN "socialStoragePath" IS NULL THEN NULL ELSE REPLACE("socialStoragePath", ${renameJob.oldPrefix}, ${renameJob.newPrefix}) END,
            "thumbnailStoragePath" = CASE WHEN "thumbnailStoragePath" IS NULL THEN NULL ELSE REPLACE("thumbnailStoragePath", ${renameJob.oldPrefix}, ${renameJob.newPrefix}) END
          WHERE "albumId" = ${renameJob.entityId}
        `
      })
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
