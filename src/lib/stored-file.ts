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
 *   - backfillStoredFiles()  — runtime backfill from legacy path columns (safe to re-run)
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
 * Uses a single DELETE … RETURNING-style operation via Prisma's delete with select.
 */
export async function deleteStoredFile(
  entityType: EntityType,
  entityId: string,
  fileRole: FileRole,
  options?: { deleteFromStorage?: boolean },
) {
  let storagePath: string | null = null

  try {
    const record = await prisma.storedFile.delete({
      where: {
        entityType_entityId_fileRole: { entityType, entityId, fileRole },
      },
      select: { storagePath: true },
    })
    storagePath = record.storagePath
  } catch (err: any) {
    if (err?.code === 'P2025') return null // not found — nothing to do
    throw err
  }

  if (options?.deleteFromStorage && storagePath) {
    try {
      if (isS3Mode()) {
        await s3DeleteFile(storagePath)
      } else {
        await deleteFile(storagePath)
      }
    } catch {
      // Best-effort — storage cleanup may fail if file already deleted
    }
  }

  return { storagePath }
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
 * Get all file paths referenced in the database (paginated).
 * Used by storage integrity scans, S3 migration, local backup.
 *
 * Defaults to 10 000 items per page. Pass cursor from previous page's
 * nextCursor to continue iteration. When nextCursor is undefined, the
 * end has been reached.
 */
export async function getAllStoredPaths(
  options?: { cursor?: string; take?: number },
): Promise<{
  items: Array<{ storagePath: string; entityType: EntityType; fileRole: FileRole }>
  nextCursor?: string
}> {
  const take = options?.take ?? 10000
  const rows = await prisma.storedFile.findMany({
    select: { id: true, entityType: true, fileRole: true, storagePath: true },
    where: { storagePath: { not: '' } },
    orderBy: { id: 'asc' },
    take: take + 1, // fetch one extra to detect whether there are more
    ...(options?.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  })

  const hasMore = rows.length > take
  if (hasMore) rows.pop()

  return {
    items: rows.map(({ id, ...rest }) => rest),
    nextCursor: hasMore ? rows[rows.length - 1]?.id : undefined,
  }
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
 *
 * SECURITY: This function performs NO authorization checks. It returns file
 * metadata (roles, entity IDs) for any entity IDs you pass. Callers MUST
 * verify that the current user has access to every entity before calling.
 * For API routes, always pair this with {@link verifyEntityAccess} or an
 * equivalent project/entity-level auth check.
 */
export async function getStoredPathsForEntities(
  entityType: EntityType,
  entityIds: string[],
) {
  if (entityIds.length === 0) return []
  return prisma.storedFile.findMany({
    where: { entityType, entityId: { in: entityIds } },
    select: { fileRole: true, entityId: true },
  })
}

/**
 * Get the stored file path for a specific entity+role.
 * Used by content delivery to resolve file paths.
 *
 * ⚠️ This function performs NO authorization.  Use it ONLY when the
 * caller has already verified access through another mechanism
 * (content-delivery tokens, worker code, or a prior verifyProjectAccess
 * call).  For API routes, prefer {@link getStoredFilePathForProject}.
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

/**
 * Get the stored file path for a specific entity+role, **verifying that
 * the entity belongs to the given project**.
 *
 * This is the safe version for API routes.  `projectId` is REQUIRED —
 * the function will return `null` if the entity doesn't exist or belongs
 * to a different project.
 *
 * Entity types with no single-project association (CLIENT_FILE,
 * USER_FILE, SETTINGS_BRANDING) will always return `null` when this
 * function is used.  For those types, use {@link getStoredFilePath}
 * and perform your own authorization.
 */
export async function getStoredFilePathForProject(
  entityType: EntityType,
  entityId: string,
  fileRole: FileRole,
  projectId: string,
): Promise<string | null> {
  const actualProjectId = await resolveEntityProjectId(entityType, entityId)
  if (actualProjectId !== projectId) return null

  const record = await prisma.storedFile.findUnique({
    where: { entityType_entityId_fileRole: { entityType, entityId, fileRole } },
    select: { storagePath: true },
  })
  return record?.storagePath ?? null
}

/**
 * Resolve the project ID that owns a given entity, if applicable.
 *
 * This is the **authorization bridge** between StoredFile lookups and
 * project-access verification.  API routes that call {@link getStoredFilePath}
 * should call this FIRST, then pass the returned projectId to
 * `verifyProjectAccess()`.
 *
 * Returns `null` for entity types that have no project association
 * (e.g. SETTINGS_BRANDING, USER_FILE).
 *
 * @returns The project ID, or null if the entity type is not project-scoped.
 */
export async function resolveEntityProjectId(
  entityType: EntityType,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case 'VIDEO': {
      const v = await prisma.video.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return v?.projectId ?? null
    }
    case 'VIDEO_ASSET': {
      const va = await prisma.videoAsset.findUnique({
        where: { id: entityId },
        select: { video: { select: { projectId: true } } },
      })
      return va?.video?.projectId ?? null
    }
    case 'SHARE_UPLOAD_FILE': {
      const uf = await prisma.shareUploadFile.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return uf?.projectId ?? null
    }
    case 'ALBUM': {
      const a = await prisma.album.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return a?.projectId ?? null
    }
    case 'ALBUM_PHOTO': {
      const ap = await prisma.albumPhoto.findUnique({
        where: { id: entityId },
        select: { album: { select: { projectId: true } } },
      })
      return ap?.album?.projectId ?? null
    }
    case 'CLIENT_FILE': {
      // ClientFile → Client → many Projects — no single project association
      return null
    }
    case 'PROJECT_FILE': {
      const pf = await prisma.projectFile.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return pf?.projectId ?? null
    }
    case 'PROJECT_EMAIL': {
      const pe = await prisma.projectEmail.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return pe?.projectId ?? null
    }
    case 'COMMENT_FILE': {
      const cmf = await prisma.commentFile.findUnique({
        where: { id: entityId },
        select: { comment: { select: { projectId: true } } },
      })
      return cmf?.comment?.projectId ?? null
    }
    case 'PROJECT_EMAIL_ATTACHMENT': {
      const pea = await prisma.projectEmailAttachment.findUnique({
        where: { id: entityId },
        select: { projectEmail: { select: { projectId: true } } },
      })
      return pea?.projectEmail?.projectId ?? null
    }
    // Non-project-scoped types — no project association exists
    case 'USER_FILE':
    case 'USER_AVATAR':
    case 'SETTINGS_BRANDING':
    case 'ACCOUNTING_ATTACHMENT':
      return null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Rename helper
// ---------------------------------------------------------------------------

/**
 * Bulk-rename storage paths for a set of entities by replacing oldPrefix with newPrefix.
 * Uses raw SQL for performance (single UPDATE, no Prisma row iteration).
 *
 * Uses SUBSTRING-based prefix replacement rather than REPLACE() to avoid
 * accidental matches of oldPrefix appearing later in the path.
 */
export async function renameStoredPaths(
  entityType: EntityType,
  entityIds: string[],
  oldPrefix: string,
  newPrefix: string,
) {
  if (entityIds.length === 0) return 0

  const prefixLen = oldPrefix.length
  const result = await prisma.$executeRaw`
    UPDATE "StoredFile"
    SET "storagePath" = ${newPrefix} || SUBSTRING("storagePath" FROM ${prefixLen + 1}::integer)
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
 *
 * SECURITY: No authorization check — callers must verify entity ownership first.
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
    select: { entityId: true, fileRole: true, storagePath: true },
  })
}

/**
 * Delete StoredFile rows matching criteria (e.g., all PREVIEW_* roles for a project's videos).
 * Does NOT delete from storage — use findStoredFilesToDelete first to get paths.
 */
export async function deleteStoredFilesByCriteria(params: {
  entityType: EntityType
  entityIds: string[]
  fileRoles?: FileRole[]
}) {
  if (params.entityIds.length === 0) return 0

  const where: any = {
    entityType: params.entityType,
    entityId: { in: params.entityIds },
  }
  if (params.fileRoles?.length) {
    where.fileRole = { in: params.fileRoles }
  }
  const result = await prisma.storedFile.deleteMany({ where })
  return result.count
}

// ---------------------------------------------------------------------------
// Batch file-size resolution with S3 fallback
// ---------------------------------------------------------------------------

/**
 * Batch-resolve file sizes for a set of entities, with S3 fallback for null sizes.
 *
 * Queries StoredFile first; any rows with a null fileSize get resolved from S3
 * (in S3 mode only).  Returns a Map<entityId, fileSize>.
 *
 * Used by the downloadable-files endpoint and anywhere else that needs to assemble
 * size-accurate file listings for end users.
 */
export async function batchResolveFileSizes(
  entityType: EntityType,
  entityIds: string[],
  fileRole: FileRole = 'ORIGINAL',
): Promise<Map<string, number>> {
  const sizeMap = new Map<string, number>()
  if (entityIds.length === 0) return sizeMap

  const stored = await prisma.storedFile.findMany({
    where: { entityType, entityId: { in: entityIds }, fileRole },
    select: { entityId: true, fileSize: true, storagePath: true },
  })

  const needsS3Fallback: Array<{ entityId: string; storagePath: string }> = []
  for (const s of stored) {
    if (s.fileSize != null) {
      sizeMap.set(s.entityId, Number(s.fileSize))
    } else if (s.storagePath) {
      needsS3Fallback.push({ entityId: s.entityId, storagePath: s.storagePath })
    }
  }

  if (needsS3Fallback.length > 0) {
    if (isS3Mode()) {
      const { s3GetFileSize } = await import('@/lib/s3-storage')
      const s3Sizes = await Promise.all(
        needsS3Fallback.map(async (f) => {
          try {
            const size = await s3GetFileSize(f.storagePath)
            return { entityId: f.entityId, size: typeof size === 'number' && size > 0 ? size : 0 }
          } catch { return { entityId: f.entityId, size: 0 } }
        }),
      )
      for (const r of s3Sizes) {
        if (r.size > 0) sizeMap.set(r.entityId, r.size)
      }
    }
  }

  return sizeMap
}

// ---------------------------------------------------------------------------
// Update helpers
// ---------------------------------------------------------------------------

/**
 * Update the storage path for a specific entity+role.
 * Used when files are moved/renamed (e.g. accounting attachment file relocations).
 */
export async function updateStoredFilePath(
  entityType: EntityType,
  entityId: string,
  fileRole: FileRole,
  newStoragePath: string,
) {
  return prisma.storedFile.update({
    where: { entityType_entityId_fileRole: { entityType, entityId, fileRole } },
    data: { storagePath: newStoragePath },
  })
}

/**
 * Check if a StoredFile record exists for the given entity+role.
 * Returns boolean — cheaper than fetching the full row.
 */
export async function storedFileExists(
  entityType: EntityType,
  entityId: string,
  fileRole: FileRole,
): Promise<boolean> {
  const count = await prisma.storedFile.count({
    where: { entityType, entityId, fileRole },
  })
  return count > 0
}

/**
 * Count StoredFile rows whose storagePath starts with a given prefix.
 * Used to detect if a file is referenced by multiple entities (shared files).
 */
export async function countStoredFilesByPrefix(
  storagePathPrefix: string,
  options?: { excludeEntityType?: EntityType; excludeEntityId?: string },
): Promise<number> {
  const where: any = { storagePath: { startsWith: storagePathPrefix } }
  if (options?.excludeEntityType || options?.excludeEntityId) {
    const not: any = {}
    if (options.excludeEntityType) not.entityType = options.excludeEntityType
    if (options.excludeEntityId) not.entityId = options.excludeEntityId
    where.NOT = not
  }
  return prisma.storedFile.count({ where })
}

/**
 * Count StoredFile rows with an exact storagePath match,
 * optionally excluding a specific entity.
 * Used to detect if a file is shared across entities.
 */
export async function countStoredFilesByPath(
  storagePath: string,
  options?: { excludeEntityType?: EntityType; excludeEntityId?: string; excludeEntityIds?: string[] },
): Promise<number> {
  const where: any = { storagePath }
  const not: any = {}
  if (options?.excludeEntityType) not.entityType = options.excludeEntityType
  if (options?.excludeEntityId) not.entityId = options.excludeEntityId
  if (options?.excludeEntityIds?.length) not.entityId = { notIn: options.excludeEntityIds }
  if (Object.keys(not).length > 0) where.NOT = not
  return prisma.storedFile.count({ where })
}

/**
 * Get StoredFile records for a set of entities, with configurable select.
 * Used by API routes that need file metadata (fileSize, fileName, etc.)
 * for multiple entities at once.
 *
 * SECURITY: No authorization check — callers must verify entity ownership first.
 */
export async function getStoredFileRecords(
  entityType: EntityType,
  entityIds: string[],
  options?: {
    fileRoles?: FileRole[]
    select?: Record<string, boolean>
  },
) {
  if (entityIds.length === 0) return []
  const where: any = { entityType, entityId: { in: entityIds } }
  if (options?.fileRoles?.length) {
    where.fileRole = { in: options.fileRoles }
  }
  return prisma.storedFile.findMany({
    where,
    select: options?.select ?? { entityId: true, fileRole: true, storagePath: true, fileName: true, fileSize: true },
  }) as any as Record<string, any>[]
}

/**
 * Run an aggregate query on the StoredFile table.
 * Used by storage overview and project storage stats endpoints
 * that need fine-grained control over filtering.
 *
 * SECURITY: No authorization check — callers must verify project access first.
 */
export async function getStoredFileAggregate(
  where: {
    entityType?: EntityType | { in: EntityType[] }
    entityId?: string | { in: string[] }
    fileRole?: FileRole | { in: FileRole[] }
  },
) {
  return prisma.storedFile.aggregate({
    where: where as any,
    _sum: { fileSize: true },
  })
}

// ---------------------------------------------------------------------------
// One-shot backfill (safe to re-run — uses ON CONFLICT DO NOTHING)
// ---------------------------------------------------------------------------

/**
 * Backfill the StoredFile table from all legacy path columns.
 *
 * **DEPRECATED.** All legacy path/size columns have been dropped.
 * The migration `20260608000002_add_stored_file_registry` ran the backfill
 * while columns still existed. This function is now a no-op.
 */
export async function backfillStoredFiles(): Promise<{ inserted: number }> {
  console.warn('[stored-file] backfillStoredFiles() is a no-op — legacy columns have been dropped.')
  return { inserted: 0 }
}

// ── Dead backfill chunks kept for historical reference only ──────────────
const _DEAD_BACKFILL_CHUNKS: Array<() => Promise<number>> = [
    // Video — 7 roles
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

    // VideoAsset — 4 roles
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

    // ShareUploadFile — 4 roles
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

    // AlbumPhoto — 3 roles
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

    // Album ZIPs — 2 roles (derived from project storagePath + album name)
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'ALBUM'::"EntityType", a."id", 'ZIP_FULL'::"FileRole",
        COALESCE(p."storagePath", '') || '/albums/' || COALESCE(a."storageFolderName", a."name") || '/zips/full/' || a."name" || '_Full_Res.zip',
        a."name" || '_Full_Res.zip', a."fullZipFileSize", 'READY'
      FROM "Album" a JOIN "Project" p ON p."id" = a."projectId"
      WHERE a."fullZipFileSize" > 0 AND p."storagePath" IS NOT NULL
      ON CONFLICT DO NOTHING`,
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'ALBUM'::"EntityType", a."id", 'ZIP_SOCIAL'::"FileRole",
        COALESCE(p."storagePath", '') || '/albums/' || COALESCE(a."storageFolderName", a."name") || '/zips/social/' || a."name" || '_Social_Sized.zip',
        a."name" || '_Social_Sized.zip', a."socialZipFileSize", 'READY'
      FROM "Album" a JOIN "Project" p ON p."id" = a."projectId"
      WHERE a."socialZipFileSize" > 0 AND p."storagePath" IS NOT NULL
      ON CONFLICT DO NOTHING`,

    // ProjectFile
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'PROJECT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "ProjectFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,

    // ClientFile
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'CLIENT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "ClientFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,

    // UserFile
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'USER_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "UserFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,

    // ProjectEmail
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'PROJECT_EMAIL'::"EntityType", e."id", 'RAW_EMAIL'::"FileRole",
        e."rawStoragePath", e."rawFileName", e."rawFileSize", 'READY'
      FROM "ProjectEmail" e WHERE e."rawStoragePath" IS NOT NULL AND e."rawStoragePath" != ''
      ON CONFLICT DO NOTHING`,

    // ProjectEmailAttachment
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'PROJECT_EMAIL_ATTACHMENT'::"EntityType", a."id", 'ORIGINAL'::"FileRole",
        a."storagePath", a."fileName", a."fileSize", 'READY'
      FROM "ProjectEmailAttachment" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != ''
      ON CONFLICT DO NOTHING`,

    // CommentFile
    () => prisma.$executeRaw`
      INSERT INTO "StoredFile" ("entityType","entityId","fileRole","storagePath","fileName","fileSize","status")
      SELECT 'COMMENT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
        f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "CommentFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
      ON CONFLICT DO NOTHING`,

    // AccountingAttachment
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

    // Settings branding — 3 roles
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

// ── End of dead backfill chunks ──────────────────────────────────────────
