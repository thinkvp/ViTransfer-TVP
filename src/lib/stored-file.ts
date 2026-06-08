/**
 * StoredFile registry — the single source of truth for every file path in the system.
 *
 * Instead of scattering path columns (preview480Path, thumbnailPath, etc.) across
 * a dozen entity tables, every file — original uploads, derived previews, thumbnails,
 * ZIPs, branding assets — gets one row in the StoredFile table.
 *
 * This module provides:
 *   - registerStoredFile()   — upsert one file row (called by workers, upload handlers)
 *   - deleteStoredFile()     — remove a file row + optional storage deletion
 *   - backfillStoredFiles()  — one-shot backfill from legacy path columns
 *   - query helpers          — find files by entity, entityType, fileRole, project, etc.
 */

import { prisma } from './db'
import { deleteFile } from './storage'
import { isS3Mode, s3DeleteFile } from './s3-storage'
import type { EntityType, FileRole } from '@prisma/client'

// Re-export for convenience
export type { EntityType, FileRole }

// ---------------------------------------------------------------------------
// Register / upsert
// ---------------------------------------------------------------------------

export interface RegisterStoredFileParams {
  entityType: EntityType
  entityId: string
  fileRole: FileRole
  storagePath: string
  fileName?: string | null
  fileSize?: bigint | number | null
  status?: string | null
  generatedAt?: Date | null
  metadata?: Record<string, unknown> | null
}

/**
 * Upsert a file record into the StoredFile registry.
 *
 * EntityType + entityId + fileRole form a natural key — each entity
 * can only have one file per role (VIDEO + videoId + PREVIEW_720).
 *
 * Called by workers, upload handlers, and reprocess flows.
 */
export async function registerStoredFile(params: RegisterStoredFileParams) {
  const data = {
    entityType: params.entityType,
    entityId: params.entityId,
    fileRole: params.fileRole,
    storagePath: params.storagePath,
    fileName: params.fileName ?? null,
    fileSize: params.fileSize != null ? BigInt(params.fileSize) : null,
    status: params.status ?? null,
    generatedAt: params.generatedAt ?? null,
    metadata: params.metadata ? (params.metadata as any) : undefined,
  }

  return prisma.storedFile.upsert({
    where: {
      entityType_entityId_fileRole: {
        entityType: params.entityType,
        entityId: params.entityId,
        fileRole: params.fileRole,
      },
    },
    create: data,
    update: data,
  })
}

// ---------------------------------------------------------------------------
// Bulk register (for workers that produce multiple files at once)
// ---------------------------------------------------------------------------

/**
 * Register multiple file records in a single transaction.
 * All-or-nothing: if any fail, none are committed.
 */
export async function registerStoredFiles(
  files: RegisterStoredFileParams[],
) {
  if (files.length === 0) return []

  return prisma.$transaction(
    files.map((f) =>
      prisma.storedFile.upsert({
        where: {
          entityType_entityId_fileRole: {
            entityType: f.entityType,
            entityId: f.entityId,
            fileRole: f.fileRole,
          },
        },
        create: {
          entityType: f.entityType,
          entityId: f.entityId,
          fileRole: f.fileRole,
          storagePath: f.storagePath,
          fileName: f.fileName ?? null,
          fileSize: f.fileSize != null ? BigInt(f.fileSize) : null,
          status: f.status ?? null,
          generatedAt: f.generatedAt ?? null,
          metadata: f.metadata ? (f.metadata as any) : undefined,
        },
        update: {
          storagePath: f.storagePath,
          fileName: f.fileName ?? null,
          fileSize: f.fileSize != null ? BigInt(f.fileSize) : null,
          status: f.status ?? null,
          generatedAt: f.generatedAt ?? null,
          metadata: f.metadata ? (f.metadata as any) : undefined,
        },
      })
    ),
  )
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Remove a file row from the registry and optionally delete from storage.
 */
export async function deleteStoredFile(
  entityType: EntityType,
  entityId: string,
  fileRole: FileRole,
  options?: { deleteFromStorage?: boolean },
) {
  const record = await prisma.storedFile.findUnique({
    where: {
      entityType_entityId_fileRole: { entityType, entityId, fileRole },
    },
    select: { storagePath: true },
  })

  if (!record) return null

  await prisma.storedFile.delete({
    where: {
      entityType_entityId_fileRole: { entityType, entityId, fileRole },
    },
  })

  if (options?.deleteFromStorage && record.storagePath) {
    try {
      if (isS3Mode()) {
        await s3DeleteFile(record.storagePath)
      } else {
        await deleteFile(record.storagePath)
      }
    } catch {
      // Best-effort — storage cleanup may fail if file already deleted
    }
  }

  return record
}

/**
 * Delete all StoredFile rows for a given entity.
 */
export async function deleteStoredFilesForEntity(
  entityType: EntityType,
  entityId: string,
) {
  return prisma.storedFile.deleteMany({
    where: { entityType, entityId },
  })
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Get all file paths referenced in the database.
 * Used by storage integrity scans, S3 migration, local backup.
 */
export async function getAllStoredPaths(): Promise<Array<{ storagePath: string; entityType: EntityType; fileRole: FileRole }>> {
  return prisma.storedFile.findMany({
    select: { storagePath: true, entityType: true, fileRole: true },
    where: { storagePath: { not: '' } },
  })
}

/**
 * Get total bytes grouped by entity type.
 * Used by Storage Overview and project storage totals.
 */
export async function getStorageTotalsByEntityType() {
  return prisma.storedFile.groupBy({
    by: ['entityType'],
    _sum: { fileSize: true },
  })
}

/**
 * Get all stored paths for a specific entity type and set of entity IDs.
 * Used for project-scoped storage queries.
 */
export async function getStoredPathsForEntities(
  entityType: EntityType,
  entityIds: string[],
) {
  if (entityIds.length === 0) return []
  return prisma.storedFile.findMany({
    where: { entityType, entityId: { in: entityIds } },
    select: { storagePath: true, fileRole: true, fileSize: true, entityId: true },
  })
}

/**
 * Get the stored file path for a specific entity+role.
 * Used by content delivery to resolve file paths.
 */
export async function getStoredFilePath(
  entityType: EntityType,
  entityId: string,
  fileRole: FileRole,
): Promise<string | null> {
  const record = await prisma.storedFile.findUnique({
    where: { entityType_entityId_fileRole: { entityType, entityId, fileRole } },
    select: { storagePath: true },
  })
  return record?.storagePath ?? null
}

// ---------------------------------------------------------------------------
// Rename helper
// ---------------------------------------------------------------------------

/**
 * Bulk-rename storage paths for a set of entities by replacing oldPrefix with newPrefix.
 * Uses raw SQL for performance (single UPDATE, no Prisma row iteration).
 */
export async function renameStoredPaths(
  entityType: EntityType,
  entityIds: string[],
  oldPrefix: string,
  newPrefix: string,
) {
  if (entityIds.length === 0) return 0

  const result = await prisma.$executeRaw`
    UPDATE "StoredFile"
    SET "storagePath" = REPLACE("storagePath", ${oldPrefix}, ${newPrefix})
    WHERE "entityType" = ${entityType}::"EntityType"
      AND "entityId" = ANY(${entityIds})
      AND "storagePath" LIKE ${oldPrefix + '%'}
  `
  return result
}

// ---------------------------------------------------------------------------
// Cleanup helpers (for closed-project, reprocess, etc.)
// ---------------------------------------------------------------------------

/**
 * Find all StoredFile rows matching a set of entity types, entity IDs, and file roles.
 * Returns the storage paths so the caller can delete the physical files.
 */
export async function findStoredFilesToDelete(params: {
  entityType: EntityType
  entityIds: string[]
  fileRoles: FileRole[]
}) {
  if (params.entityIds.length === 0 || params.fileRoles.length === 0) return []

  return prisma.storedFile.findMany({
    where: {
      entityType: params.entityType,
      entityId: { in: params.entityIds },
      fileRole: { in: params.fileRoles },
    },
    select: { storagePath: true, entityId: true, fileRole: true },
  })
}

/**
 * Delete StoredFile rows matching criteria (e.g., all PREVIEW_* roles for a project's videos).
 * Does NOT delete from storage — use findStoredFilesToDelete first to get paths.
 */
export async function deleteStoredFilesByCriteria(params: {
  entityType: EntityType
  entityIds: string[]
  fileRoles: FileRole[]
}) {
  if (params.entityIds.length === 0 || params.fileRoles.length === 0) return 0

  const result = await prisma.storedFile.deleteMany({
    where: {
      entityType: params.entityType,
      entityId: { in: params.entityIds },
      fileRole: { in: params.fileRoles },
    },
  })
  return result.count
}

// ---------------------------------------------------------------------------
// One-shot backfill (callable from a script or admin action)
// ---------------------------------------------------------------------------

/**
 * Backfill the StoredFile table from all legacy path columns.
 * Safe to call multiple times — uses ON CONFLICT DO NOTHING.
 *
 * This is the same SQL as the migration, packaged for runtime use
 * (e.g. from a developer tools action or a post-deploy script).
 */
export async function backfillStoredFiles(): Promise<{ inserted: number }> {
  const chunks: Array<() => Promise<number>> = [
    // Video
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'VIDEO'::"EntityType", v."id", 'ORIGINAL'::"FileRole",
        v."originalStoragePath", v."originalFileName", v."originalFileSize",
        CASE v."status" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' ELSE 'PENDING' END
      FROM "Video" v WHERE v."originalStoragePath" IS NOT NULL AND v."originalStoragePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'VIDEO'::"EntityType", v."id", 'PREVIEW_480'::"FileRole", v."preview480Path", 'READY'
      FROM "Video" v WHERE v."preview480Path" IS NOT NULL AND v."preview480Path" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'VIDEO'::"EntityType", v."id", 'PREVIEW_720'::"FileRole", v."preview720Path", 'READY'
      FROM "Video" v WHERE v."preview720Path" IS NOT NULL AND v."preview720Path" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'VIDEO'::"EntityType", v."id", 'PREVIEW_1080'::"FileRole", v."preview1080Path", 'READY'
      FROM "Video" v WHERE v."preview1080Path" IS NOT NULL AND v."preview1080Path" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'VIDEO'::"EntityType", v."id", 'THUMBNAIL'::"FileRole", v."thumbnailPath", 'READY'
      FROM "Video" v WHERE v."thumbnailPath" IS NOT NULL AND v."thumbnailPath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'VIDEO'::"EntityType", v."id", 'TIMELINE_VTT'::"FileRole", v."timelinePreviewVttPath",
        CASE WHEN v."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "Video" v WHERE v."timelinePreviewVttPath" IS NOT NULL AND v."timelinePreviewVttPath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'VIDEO'::"EntityType", v."id", 'TIMELINE_SPRITES'::"FileRole", v."timelinePreviewSpritesPath",
        CASE WHEN v."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "Video" v WHERE v."timelinePreviewSpritesPath" IS NOT NULL AND v."timelinePreviewSpritesPath" != ''
      ON CONFLICT DO NOTHING`,

    // VideoAsset
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'VIDEO_ASSET'::"EntityType", a."id", 'ORIGINAL'::"FileRole",
        a."storagePath", a."fileName", a."fileSize", 'READY'
      FROM "VideoAsset" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileSize","status")
      SELECT 'VIDEO_ASSET'::"EntityType", a."id", 'PREVIEW_IMAGE'::"FileRole",
        a."previewPath", a."previewFileSize", a."previewStatus"
      FROM "VideoAsset" a WHERE a."previewPath" IS NOT NULL AND a."previewPath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'VIDEO_ASSET'::"EntityType", a."id", 'TIMELINE_VTT'::"FileRole", a."timelinePreviewVttPath",
        CASE WHEN a."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "VideoAsset" a WHERE a."timelinePreviewVttPath" IS NOT NULL AND a."timelinePreviewVttPath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'VIDEO_ASSET'::"EntityType", a."id", 'TIMELINE_SPRITES'::"FileRole", a."timelinePreviewSpritesPath",
        CASE WHEN a."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "VideoAsset" a WHERE a."timelinePreviewSpritesPath" IS NOT NULL AND a."timelinePreviewSpritesPath" != ''
      ON CONFLICT DO NOTHING`,

    // ShareUploadFile
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "ShareUploadFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileSize","status")
      SELECT 'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'PREVIEW_IMAGE'::"FileRole",
        f."previewPath", f."previewFileSize", f."previewStatus"
      FROM "ShareUploadFile" f WHERE f."previewPath" IS NOT NULL AND f."previewPath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'TIMELINE_VTT'::"FileRole", f."timelinePreviewVttPath",
        CASE WHEN f."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "ShareUploadFile" f WHERE f."timelinePreviewVttPath" IS NOT NULL AND f."timelinePreviewVttPath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'TIMELINE_SPRITES'::"FileRole", f."timelinePreviewSpritesPath",
        CASE WHEN f."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "ShareUploadFile" f WHERE f."timelinePreviewSpritesPath" IS NOT NULL AND f."timelinePreviewSpritesPath" != ''
      ON CONFLICT DO NOTHING`,

    // AlbumPhoto
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'ALBUM_PHOTO'::"EntityType", p."id", 'ORIGINAL'::"FileRole",
        p."storagePath", p."fileName", p."fileSize",
        CASE p."status" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' ELSE 'PENDING' END
      FROM "AlbumPhoto" p WHERE p."storagePath" IS NOT NULL AND p."storagePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileSize","status")
      SELECT 'ALBUM_PHOTO'::"EntityType", p."id", 'SOCIAL'::"FileRole",
        p."socialStoragePath", p."socialFileSize",
        CASE p."socialStatus" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' WHEN 'PROCESSING' THEN 'PROCESSING' ELSE 'PENDING' END
      FROM "AlbumPhoto" p WHERE p."socialStoragePath" IS NOT NULL AND p."socialStoragePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileSize","status")
      SELECT 'ALBUM_PHOTO'::"EntityType", p."id", 'THUMBNAIL'::"FileRole",
        p."thumbnailStoragePath", p."thumbnailFileSize",
        CASE p."thumbnailStatus" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' WHEN 'PROCESSING' THEN 'PROCESSING' ELSE 'PENDING' END
      FROM "AlbumPhoto" p WHERE p."thumbnailStoragePath" IS NOT NULL AND p."thumbnailStoragePath" != ''
      ON CONFLICT DO NOTHING`,

    // Album ZIPs
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'ALBUM'::"EntityType", a."id", 'ZIP_FULL'::"FileRole",
        COALESCE(p."storagePath",'') || '/albums/' || COALESCE(a."storageFolderName",a."name") || '/zips/full/' || a."name" || '_Full_Res.zip',
        a."name" || '_Full_Res.zip', a."fullZipFileSize", 'READY'
      FROM "Album" a JOIN "Project" p ON p."id" = a."projectId"
      WHERE a."fullZipFileSize" > 0 AND p."storagePath" IS NOT NULL
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'ALBUM'::"EntityType", a."id", 'ZIP_SOCIAL'::"FileRole",
        COALESCE(p."storagePath",'') || '/albums/' || COALESCE(a."storageFolderName",a."name") || '/zips/social/' || a."name" || '_Social_Sized.zip',
        a."name" || '_Social_Sized.zip', a."socialZipFileSize", 'READY'
      FROM "Album" a JOIN "Project" p ON p."id" = a."projectId"
      WHERE a."socialZipFileSize" > 0 AND p."storagePath" IS NOT NULL
      ON CONFLICT DO NOTHING`,

    // Simple single-file entities
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'PROJECT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "ProjectFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'CLIENT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "ClientFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'USER_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "UserFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'PROJECT_EMAIL'::"EntityType", e."id", 'RAW_EMAIL'::"FileRole",
        e."rawStoragePath", e."rawFileName", e."rawFileSize", 'READY'
      FROM "ProjectEmail" e WHERE e."rawStoragePath" IS NOT NULL AND e."rawStoragePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'PROJECT_EMAIL_ATTACHMENT'::"EntityType", a."id", 'ORIGINAL'::"FileRole",
        a."storagePath", a."fileName", a."fileSize", 'READY'
      FROM "ProjectEmailAttachment" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'COMMENT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "CommentFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'ACCOUNTING_ATTACHMENT'::"EntityType", a."id", 'ORIGINAL'::"FileRole",
        a."storagePath", a."originalName", a."fileSize", 'READY'
      FROM "AccountingAttachment" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != ''
      ON CONFLICT DO NOTHING`,

    // User avatar
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'USER_AVATAR'::"EntityType", u."id", 'AVATAR'::"FileRole", u."avatarPath", 'READY'
      FROM "User" u WHERE u."avatarPath" IS NOT NULL AND u."avatarPath" != ''
      ON CONFLICT DO NOTHING`,

    // Settings branding
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_LOGO'::"FileRole", s."companyLogoPath", 'READY'
      FROM "Settings" s WHERE s."companyLogoPath" IS NOT NULL AND s."companyLogoPath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_DARK_LOGO'::"FileRole", s."darkLogoPath", 'READY'
      FROM "Settings" s WHERE s."darkLogoPath" IS NOT NULL AND s."darkLogoPath" != ''
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","status")
      SELECT 'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_FAVICON'::"FileRole", s."companyFaviconPath", 'READY'
      FROM "Settings" s WHERE s."companyFaviconPath" IS NOT NULL AND s."companyFaviconPath" != ''
      ON CONFLICT DO NOTHING`,
  ]

  let totalInserted = 0
  for (const chunk of chunks) {
    try {
      totalInserted += await chunk()
    } catch (err) {
      console.error('[StoredFile] Backfill chunk failed:', err)
    }
  }

  console.log(`[StoredFile] Backfill complete: ${totalInserted} rows inserted`)
  return { inserted: totalInserted }
}
