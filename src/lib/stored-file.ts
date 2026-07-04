/**
 * StoredFile registry — the single source of truth for every file path in the system.
 *
 * Instead of scattering path columns (preview480Path, thumbnailPath, etc.) across
 * a dozen entity tables, every file — original uploads, derived previews, thumbnails,
 * ZIPs, branding assets — gets one row in the StoredFile table.
 *
 * This module provides:
 *   - registerStoredFile()        — upsert one file row (called by workers, upload handlers)
 *   - deleteStoredFile()          — remove a file row + optional storage deletion
 *   - deleteStoredFilesForProject() — one-shot cleanup of every file row for a project
 *   - findDanglingStoredFiles()   — rows whose owning entity no longer exists (reconciliation)
 *   - query helpers               — find files by entity, entityType, fileRole, project, etc.
 *
 * Every row carries a denormalized `projectId` (populated automatically from the owning
 * entity) so project-scoped lifecycle operations don't have to enumerate all 14 entity types.
 */

import { prisma } from './db'
import { deleteFile, deleteDirectory } from './storage'
import { isS3Mode } from './s3-storage'
import type { EntityType, FileRole, Prisma } from '@prisma/client'

/**
 * Either the global Prisma client or an interactive-transaction client. Passing a
 * transaction client lets entity creation + StoredFile registration commit atomically,
 * so a failure can't leave an entity row without its file registration.
 */
type DbClient = typeof prisma | Prisma.TransactionClient

// Re-export for convenience
export type { EntityType, FileRole }

/**
 * Canonical map from a preview resolution label to its StoredFile role.
 * Use this instead of re-declaring the mapping in reprocess / delete-previews routes.
 */
export const RESOLUTION_TO_FILE_ROLE: Record<string, FileRole> = {
  '480p': 'PREVIEW_480',
  '720p': 'PREVIEW_720',
  '1080p': 'PREVIEW_1080',
}

/**
 * Roles whose storagePath is a DIRECTORY (one row, many files inside), not a
 * single object. Storage deletion for these must remove the whole prefix/tree.
 */
export const DIRECTORY_FILE_ROLES: ReadonlySet<FileRole> = new Set<FileRole>([
  'TIMELINE_SPRITES',
  'HLS_SEGMENTS',
])

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
  /**
   * Owning project. Leave undefined to have it auto-resolved from the entity via
   * resolveEntityProjectId() (the common case — callers need not know it). Pass it
   * explicitly (including `null` for non-project files) to skip the lookup on hot paths.
   */
  projectId?: string | null
}

/**
 * Build the column data for the upsert create branch: omitted optional fields
 * default to null.
 */
function buildStoredFileCreateData(params: RegisterStoredFileParams, projectId: string | null) {
  return {
    projectId,
    storagePath: params.storagePath,
    fileName: params.fileName ?? null,
    fileSize: params.fileSize != null ? BigInt(params.fileSize) : null,
    status: params.status ?? null,
    generatedAt: params.generatedAt ?? null,
    metadata: params.metadata ? (params.metadata as any) : undefined,
  }
}

/**
 * Build the column data for the upsert update branch: omitted (undefined)
 * optional fields leave the existing value UNCHANGED, so a partial re-register
 * (e.g. a status-only update) can't wipe a known fileSize/fileName. Passing an
 * explicit null still clears the field.
 */
function buildStoredFileUpdateData(params: RegisterStoredFileParams, projectId: string | null) {
  return {
    projectId,
    storagePath: params.storagePath,
    fileName: params.fileName === undefined ? undefined : params.fileName,
    fileSize: params.fileSize === undefined ? undefined : params.fileSize != null ? BigInt(params.fileSize) : null,
    status: params.status === undefined ? undefined : params.status,
    generatedAt: params.generatedAt === undefined ? undefined : params.generatedAt,
    metadata: params.metadata ? (params.metadata as any) : undefined,
  }
}

/** Resolve projectId for a register call: explicit value wins, otherwise derive from the entity. */
async function resolveProjectIdForParams(params: RegisterStoredFileParams, db: DbClient): Promise<string | null> {
  if (params.projectId !== undefined) return params.projectId
  return resolveEntityProjectId(params.entityType, params.entityId, db)
}

/**
 * Upsert a file record into the StoredFile registry.
 *
 * EntityType + entityId + fileRole form a natural key — each entity
 * can only have one file per role (VIDEO + videoId + PREVIEW_720).
 *
 * Called by workers, upload handlers, and reprocess flows.
 */
export async function registerStoredFile(params: RegisterStoredFileParams, db: DbClient = prisma) {
  const projectId = await resolveProjectIdForParams(params, db)

  return db.storedFile.upsert({
    where: {
      entityType_entityId_fileRole: {
        entityType: params.entityType,
        entityId: params.entityId,
        fileRole: params.fileRole,
      },
    },
    create: {
      entityType: params.entityType,
      entityId: params.entityId,
      fileRole: params.fileRole,
      ...buildStoredFileCreateData(params, projectId),
    },
    update: buildStoredFileUpdateData(params, projectId),
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

  // Resolve projectId once per unique entity (a video finalize registers ~6 roles for the
  // same videoId) so we don't issue a resolveEntityProjectId() query per file.
  const toResolve = new Map<string, { entityType: EntityType; entityId: string }>()
  for (const f of files) {
    if (f.projectId !== undefined) continue
    toResolve.set(`${f.entityType}:${f.entityId}`, { entityType: f.entityType, entityId: f.entityId })
  }
  const resolvedByKey = new Map<string, string | null>()
  await Promise.all(
    [...toResolve].map(async ([key, { entityType, entityId }]) => {
      resolvedByKey.set(key, await resolveEntityProjectId(entityType, entityId))
    }),
  )
  const projectIdFor = (f: RegisterStoredFileParams): string | null =>
    f.projectId !== undefined ? f.projectId : (resolvedByKey.get(`${f.entityType}:${f.entityId}`) ?? null)

  return prisma.$transaction(
    files.map((f) => {
      const projectId = projectIdFor(f)
      return prisma.storedFile.upsert({
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
          ...buildStoredFileCreateData(f, projectId),
        },
        update: buildStoredFileUpdateData(f, projectId),
      })
    }),
  )
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Remove a file row from the registry and optionally delete from storage.
 * Uses a single DELETE … RETURNING-style operation via Prisma's delete with select.
 *
 * Storage deletion is guarded:
 * - Directory roles (TIMELINE_SPRITES, HLS_SEGMENTS) delete the whole prefix/tree —
 *   a single-object delete on a directory path would silently strand its contents.
 * - If another StoredFile row still references the same path (shared paths, e.g.
 *   custom video thumbnails aliasing an asset's ORIGINAL), the object is kept.
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
      // Shared-path guard: our row is already deleted, so any remaining row with
      // this exact path means another entity still uses the underlying object.
      const stillReferenced = await countStoredFilesByPath(storagePath)
      if (stillReferenced > 0) {
        console.log(`[StoredFile] Skipping storage delete of shared path (${stillReferenced} other reference(s)): ${storagePath}`)
      } else if (DIRECTORY_FILE_ROLES.has(fileRole)) {
        await deleteDirectory(storagePath)
      } else {
        await deleteFile(storagePath)
      }
    } catch (err) {
      // Best-effort, but never silent: a failed delete strands a paid object in R2.
      console.warn(`[StoredFile] Failed to delete storage object ${storagePath} (${entityType}/${entityId}/${fileRole}):`, err instanceof Error ? err.message : err)
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

/**
 * Delete every StoredFile row belonging to a project, regardless of entity type.
 *
 * This is the one-shot replacement for enumerating videos/assets/albums/photos/
 * comments/files/etc. on project deletion — relies on the denormalized `projectId`
 * populated at registration time. Does NOT touch storage (project deletion removes
 * the whole project directory separately).
 */
export async function deleteStoredFilesForProject(projectId: string) {
  const result = await prisma.storedFile.deleteMany({ where: { projectId } })
  return result.count
}

/** Delete StoredFile rows by primary key. Used by reconciliation to prune dangling rows. */
export async function deleteStoredFilesByIds(ids: string[]) {
  if (ids.length === 0) return 0
  const result = await prisma.storedFile.deleteMany({ where: { id: { in: ids } } })
  return result.count
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
  db: DbClient = prisma,
): Promise<string | null> {
  switch (entityType) {
    case 'VIDEO': {
      const v = await db.video.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return v?.projectId ?? null
    }
    case 'VIDEO_ASSET': {
      const va = await db.videoAsset.findUnique({
        where: { id: entityId },
        select: { video: { select: { projectId: true } } },
      })
      return va?.video?.projectId ?? null
    }
    case 'SHARE_UPLOAD_FILE': {
      const uf = await db.shareUploadFile.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return uf?.projectId ?? null
    }
    case 'ALBUM': {
      const a = await db.album.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return a?.projectId ?? null
    }
    case 'ALBUM_PHOTO': {
      const ap = await db.albumPhoto.findUnique({
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
      const pf = await db.projectFile.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return pf?.projectId ?? null
    }
    case 'PROJECT_EMAIL': {
      const pe = await db.projectEmail.findUnique({ where: { id: entityId }, select: { projectId: true } })
      return pe?.projectId ?? null
    }
    case 'COMMENT_FILE': {
      const cmf = await db.commentFile.findUnique({
        where: { id: entityId },
        select: { comment: { select: { projectId: true } } },
      })
      return cmf?.comment?.projectId ?? null
    }
    case 'PROJECT_EMAIL_ATTACHMENT': {
      const pea = await db.projectEmailAttachment.findUnique({
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
    default: {
      // Exhaustiveness guard: adding a new EntityType without wiring it up here
      // becomes a compile error instead of silently resolving to "not project-scoped".
      const _exhaustive: never = entityType
      void _exhaustive
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Dangling-row reconciliation (rows whose owning entity no longer exists)
// ---------------------------------------------------------------------------

export interface DanglingStoredFile {
  id: string
  entityType: EntityType
  entityId: string
  fileRole: FileRole
  storagePath: string
  fileSize: bigint | null
}

/**
 * Return the subset of `ids` that still exist for a given entity type.
 *
 * Conservative by design: entity types whose ids can't be verified against a table
 * (e.g. SETTINGS_BRANDING uses a synthetic 'default' id) return ALL ids, so they are
 * never mistaken for dangling rows and deleted.
 */
async function existingEntityIds(entityType: EntityType, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const where = { id: { in: ids } }
  const select = { id: true }
  let rows: Array<{ id: string }>
  switch (entityType) {
    case 'VIDEO': rows = await prisma.video.findMany({ where, select }); break
    case 'VIDEO_ASSET': rows = await prisma.videoAsset.findMany({ where, select }); break
    case 'SHARE_UPLOAD_FILE': rows = await prisma.shareUploadFile.findMany({ where, select }); break
    case 'ALBUM_PHOTO': rows = await prisma.albumPhoto.findMany({ where, select }); break
    case 'ALBUM': rows = await prisma.album.findMany({ where, select }); break
    case 'PROJECT_FILE': rows = await prisma.projectFile.findMany({ where, select }); break
    case 'CLIENT_FILE': rows = await prisma.clientFile.findMany({ where, select }); break
    case 'USER_FILE': rows = await prisma.userFile.findMany({ where, select }); break
    case 'USER_AVATAR': rows = await prisma.user.findMany({ where, select }); break // entityId = userId
    case 'PROJECT_EMAIL': rows = await prisma.projectEmail.findMany({ where, select }); break
    case 'PROJECT_EMAIL_ATTACHMENT': rows = await prisma.projectEmailAttachment.findMany({ where, select }); break
    case 'COMMENT_FILE': rows = await prisma.commentFile.findMany({ where, select }); break
    case 'ACCOUNTING_ATTACHMENT': rows = await prisma.accountingAttachment.findMany({ where, select }); break
    // Synthetic / unverifiable ids — treat all as existing so we never delete them.
    case 'SETTINGS_BRANDING':
    default:
      return new Set(ids)
  }
  return new Set(rows.map(r => r.id))
}

/**
 * Find StoredFile rows whose owning entity no longer exists ("dangling" rows).
 *
 * The third leg of storage reconciliation, alongside orphan files (file on disk, no
 * row) and missing files (row, no file on disk). Dangling rows accumulate when an
 * entity is deleted but its StoredFile rows weren't cleaned up. They are otherwise
 * invisible — they masquerade as "missing files" and inflate storage totals.
 *
 * Paginates the table and batches existence checks per entity type.
 */
export async function findDanglingStoredFiles(options?: { pageSize?: number }): Promise<DanglingStoredFile[]> {
  const pageSize = options?.pageSize ?? 5000
  const dangling: DanglingStoredFile[] = []
  let cursor: string | undefined

  do {
    const rows: DanglingStoredFile[] = await prisma.storedFile.findMany({
      select: { id: true, entityType: true, entityId: true, fileRole: true, storagePath: true, fileSize: true },
      orderBy: { id: 'asc' },
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    const hasMore = rows.length > pageSize
    if (hasMore) rows.pop()

    const idsByType = new Map<EntityType, Set<string>>()
    for (const r of rows) {
      let set = idsByType.get(r.entityType)
      if (!set) { set = new Set(); idsByType.set(r.entityType, set) }
      set.add(r.entityId)
    }

    const existsByType = new Map<EntityType, Set<string>>()
    await Promise.all(
      [...idsByType].map(async ([entityType, ids]) => {
        existsByType.set(entityType, await existingEntityIds(entityType, [...ids]))
      }),
    )

    for (const r of rows) {
      if (!existsByType.get(r.entityType)?.has(r.entityId)) dangling.push(r)
    }

    cursor = hasMore ? rows[rows.length - 1]?.id : undefined
  } while (cursor)

  return dangling
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
      const resolved = s3Sizes.filter((r) => r.size > 0)
      for (const r of resolved) {
        sizeMap.set(r.entityId, r.size)
      }
      // Persist the resolved sizes so the row self-heals — otherwise every listing
      // render pays an S3 HEAD per null-size row, forever. Fire-and-forget.
      if (resolved.length > 0) {
        void Promise.all(
          resolved.map((r) =>
            prisma.storedFile.updateMany({
              where: { entityType, entityId: r.entityId, fileRole, fileSize: null },
              data: { fileSize: BigInt(r.size) },
            }),
          ),
        ).catch((err) => {
          console.warn('[StoredFile] Failed to backfill resolved file sizes:', err instanceof Error ? err.message : err)
        })
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
 * Determine which of the given videos have a *custom* thumbnail — i.e. their
 * VIDEO/THUMBNAIL row points at one of the video's own VideoAsset files (set via
 * "Set as video thumbnail") rather than at a generated thumbnail.jpg.
 *
 * Custom thumbnails are recorded by repointing the VIDEO/THUMBNAIL row at the
 * asset's stored path — there is NO VIDEO_ASSET/THUMBNAIL row. Any flow that
 * deletes thumbnails by role MUST consult this first, otherwise it will delete
 * the asset's original file (which the THUMBNAIL shares) out from under it.
 *
 * Batched equivalent of videoHasCustomThumbnail() in the video-processor worker.
 *
 * SECURITY: No authorization check — callers must verify video ownership first.
 */
export async function getVideosWithCustomThumbnail(videoIds: string[]): Promise<Set<string>> {
  const result = new Set<string>()
  if (videoIds.length === 0) return result

  // 1. Resolve each video's current THUMBNAIL path.
  const thumbRows = await prisma.storedFile.findMany({
    where: { entityType: 'VIDEO', entityId: { in: videoIds }, fileRole: 'THUMBNAIL' },
    select: { entityId: true, storagePath: true },
  })
  const thumbPathByVideo = new Map<string, string>()
  for (const r of thumbRows) {
    if (r.storagePath) thumbPathByVideo.set(r.entityId, r.storagePath)
  }
  if (thumbPathByVideo.size === 0) return result

  // 2. Map each of those videos' assets back to their owning video.
  const assets = await prisma.videoAsset.findMany({
    where: { videoId: { in: [...thumbPathByVideo.keys()] } },
    select: { id: true, videoId: true },
  })
  if (assets.length === 0) return result
  const videoByAsset = new Map<string, string>()
  for (const a of assets) videoByAsset.set(a.id, a.videoId)

  // 3. A video has a custom thumbnail if its THUMBNAIL path equals one of its
  //    own assets' stored paths.
  const assetStored = await prisma.storedFile.findMany({
    where: { entityType: 'VIDEO_ASSET', entityId: { in: [...videoByAsset.keys()] } },
    select: { entityId: true, storagePath: true },
  })
  const assetPathsByVideo = new Map<string, Set<string>>()
  for (const s of assetStored) {
    const vid = videoByAsset.get(s.entityId)
    if (!vid || !s.storagePath) continue
    let set = assetPathsByVideo.get(vid)
    if (!set) { set = new Set(); assetPathsByVideo.set(vid, set) }
    set.add(s.storagePath)
  }
  for (const [vid, thumbPath] of thumbPathByVideo) {
    if (assetPathsByVideo.get(vid)?.has(thumbPath)) result.add(vid)
  }
  return result
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
 * Return the subset of the given user IDs that have a profile avatar registered in StoredFile.
 * Used to avoid exposing /api/users/[id]/avatar URLs (and the resulting 404 + initials fallback)
 * for users on default initials. One query for the whole batch.
 */
export async function getUserIdsWithAvatar(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const rows = await getStoredFileRecords('USER_AVATAR', userIds, {
    fileRoles: ['AVATAR'],
    select: { entityId: true },
  })
  return new Set(rows.map((r) => r.entityId as string))
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
