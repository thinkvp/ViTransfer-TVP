/**
 * S3 Local Backup
 *
 * Downloads files from S3 to local storage so that S3 can be disabled
 * at any time without missing files.  Files are saved to the same paths
 * they would occupy under normal "local" storage, so the application can
 * fall back to local mode transparently.
 *
 * Comparison strategy: size-based.  If the local file already exists and
 * its byte count matches the S3 object's ContentLength the file is skipped,
 * avoiding unnecessary downloads.
 *
 * Accounting files live under a separate root (ACCOUNTING_STORAGE_ROOT) and
 * are stored in S3 under the `accounting/` prefix.  All other files are stored
 * in S3 under their natural path and downloaded to STORAGE_ROOT.
 */

import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { prisma } from '@/lib/db'
import {
  getS3Client,
  getS3Bucket,
  isS3Mode,
} from '@/lib/s3-storage'
import {
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { resolveAccountingFilePath, toAccountingS3Key } from '@/lib/accounting/file-storage'
import { getAlbumZipStoragePaths } from '@/lib/album-photo-zip'
import { buildAlbumZipStoragePath, buildAlbumPhotoPreviewStoragePath, buildProjectStorageRoot, buildVideoAssetPreviewStoragePath } from '@/lib/project-storage-paths'
import { getAllStoredPaths, type EntityType, type FileRole } from '@/lib/stored-file'

// ---------------------------------------------------------------------------
// StoredFile-backed key collectors
// ---------------------------------------------------------------------------

/**
 * Collect FileEntry records from StoredFile for given entity types and file roles.
 * Replaces per-entity-table queries used previously in collectKeysForCategory.
 * Paginates through StoredFile to avoid loading all rows into memory.
 */
async function collectStoredKeys(
  entityTypes: EntityType[],
  fileRoles: FileRole[],
): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  const etSet = new Set(entityTypes)
  const frSet = new Set(fileRoles)

  let cursor: string | undefined
  do {
    const page = await getAllStoredPaths({ cursor, take: 5000 })
    for (const entry of page.items) {
      if (!entry.storagePath || !etSet.has(entry.entityType) || !frSet.has(entry.fileRole)) continue
      const key = normalizeKey(entry.storagePath)
      if (key) entries.push({ key, localPath: path.join(STORAGE_ROOT, key) })
    }
    cursor = page.nextCursor
  } while (cursor)

  return entries
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALL_BACKUP_CATEGORIES = [
  'originalVideosBytes',
  'videoPreviewsBytes',
  'videoAssetsBytes',
  'commentAttachmentsBytes',
  'uploadsFilesBytes',
  'originalPhotosBytes',
  'photoZipBytes',
  'communicationsBytes',
  'projectFilesBytes',
  'clientFilesBytes',
  'userFilesBytes',
  'accountingFilesBytes',
] as const

export type BackupCategory = (typeof ALL_BACKUP_CATEGORIES)[number]

export interface S3LocalBackupResult {
  ok: boolean
  dryRun?: boolean
  categories: BackupCategory[]
  totalKeys: number
  skipped: number
  downloaded: number
  wouldDownload?: number
  failed: number
  errors: string[]
  durationMs: number
}

/** Optional progress callback supplied by callers (e.g. the API route) to report live status. */
export type BackupProgressFn = (info: {
  currentCategory: BackupCategory
  categoryIndex: number       // 0-based index of current category
  totalCategories: number
  filesInCategory: number     // total files collected for this category
  filesProcessed: number      // files processed so far in this category (skipped + downloaded + failed)
  downloaded: number          // global totals
  skipped: number
  failed: number
}) => void | Promise<void>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')
const UPLOAD_FOLDER_MARKER = '.vitransfer_folder'

function normalizeKey(raw: string | null | undefined): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const key = trimmed.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!key || key === '.tus-tmp' || key.startsWith('.tus-tmp/')) return null
  return key
}

/** Returns true if a local file at `absPath` has exactly `expectedBytes` bytes. */
async function localFileSizeMatches(absPath: string, expectedBytes: number): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(absPath)
    return stat.isFile() && stat.size === expectedBytes
  } catch {
    return false
  }
}

/** Gets an S3 object's ContentLength without downloading the body. Returns null if not found. */
async function getS3Size(client: ReturnType<typeof getS3Client>, bucket: string, key: string): Promise<number | null> {
  try {
    const resp = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return resp.ContentLength ?? null
  } catch (err: any) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null
    throw err
  }
}

/** Lists all S3 object keys under `prefix` (non-recursive equivalent of a directory listing). */
async function listS3Keys(
  client: ReturnType<typeof getS3Client>,
  bucket: string,
  prefix: string,
): Promise<Array<{ key: string; size: number }>> {
  const normalised = prefix.endsWith('/') ? prefix : `${prefix}/`
  const results: Array<{ key: string; size: number }> = []
  let continuationToken: string | undefined

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalised,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    )
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) results.push({ key: obj.Key, size: obj.Size ?? 0 })
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
  } while (continuationToken)

  return results
}

/** Download one S3 key to the given local absolute path, creating parent dirs as needed. */
async function downloadKey(
  client: ReturnType<typeof getS3Client>,
  bucket: string,
  key: string,
  localAbsPath: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(localAbsPath), { recursive: true })
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!resp.Body) throw new Error(`No body returned for key: ${key}`)
  const readable = resp.Body as unknown as Readable
  // Write to a temp file first so a partial download never replaces a good file.
  const tmpPath = `${localAbsPath}.s3backup-tmp`
  try {
    await pipeline(readable, fs.createWriteStream(tmpPath))
    await fs.promises.rename(tmpPath, localAbsPath)
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {})
    throw err
  }
}

// ---------------------------------------------------------------------------
// Key collection per category
// ---------------------------------------------------------------------------

/** Simple file record: S3 key + local absolute path to write to. */
interface FileEntry {
  key: string
  localPath: string
}

/** Accounting paths: S3 key `accounting/{rel}` → local `ACCOUNTING_STORAGE_ROOT/{rel}` */
async function collectAccountingKeys(): Promise<FileEntry[]> {
  const rows = await prisma.storedFile.findMany({
    where: { entityType: 'ACCOUNTING_ATTACHMENT' as any },
    select: { storagePath: true },
  })
  const entries: FileEntry[] = []
  for (const row of rows) {
    const rel = normalizeKey(row.storagePath)
    if (!rel) continue
    const s3Key = toAccountingS3Key(rel)
    const localPath = resolveAccountingFilePath(rel)
    entries.push({ key: s3Key, localPath })
  }

  // Also list BAS attachment files (they may not always be in the accounting_attachment table)
  // We handle them via the S3 prefix listing to catch any orphaned-but-present files
  // (accounting category only lists DB-tracked files; untracked accounting files are skipped).
  return entries
}

/** Collect S3 keys for timeline sprites from StoredFile registry. */
async function collectTimelineSpriteKeys(client: ReturnType<typeof getS3Client>, bucket: string): Promise<FileEntry[]> {
  const allPrefixes: string[] = []
  let cursor: string | undefined
  do {
    const page = await getAllStoredPaths({ cursor, take: 5000 })
    for (const e of page.items) {
      if (e.fileRole === 'TIMELINE_SPRITES' && e.storagePath) allPrefixes.push(e.storagePath)
    }
    cursor = page.nextCursor
  } while (cursor)
  const entries: FileEntry[] = []
  for (const spritesPath of allPrefixes) {
    const prefix = normalizeKey(spritesPath)
    if (!prefix) continue
    const objects = await listS3Keys(client, bucket, prefix).catch(() => [])
    for (const obj of objects) {
      entries.push({
        key: obj.key,
        localPath: path.join(STORAGE_ROOT, obj.key),
      })
    }
  }
  return entries
}

/** Collect album preview photo paths (derived from storagePath — low-res previews used in album viewer). */
async function collectAlbumPhotoPreviewKeys(): Promise<FileEntry[]> {
  const photos = await prisma.albumPhoto.findMany({
    select: { id: true, album: {
        select: {
          name: true,
          storageFolderName: true,
          project: {
            select: { title: true,
              companyName: true,
              storagePath: true,
              client: { select: { name: true } },
            },
          },
        },
      },
    },
  })

  // Batch-load StoredFile paths for all photos
  const photoIds = photos.map(p => p.id)
  const storedPaths = new Map<string, string>()
  if (photoIds.length > 0) {
    const stored = await prisma.storedFile.findMany({
      where: { entityType: 'ALBUM_PHOTO', entityId: { in: photoIds }, fileRole: 'ORIGINAL' },
      select: { entityId: true, storagePath: true },
    })
    for (const s of stored) storedPaths.set(s.entityId, s.storagePath)
  }

  const entries: FileEntry[] = []
  for (const photo of photos) {
    const base = storedPaths.get(photo.id)
    if (!base) continue
    const projectPath = photo.album.project.storagePath
      || buildProjectStorageRoot(photo.album.project.client?.name || photo.album.project.companyName || 'Client', photo.album.project.title)
    const previewKey = normalizeKey(buildAlbumPhotoPreviewStoragePath(projectPath, base))
    if (!previewKey) continue
    entries.push({ key: previewKey, localPath: path.join(STORAGE_ROOT, previewKey) })
  }
  return entries
}

/** Collect album ZIP paths (full + social variants), derived from DB. */
async function collectAlbumZipKeys(): Promise<FileEntry[]> {
  const albums = await prisma.album.findMany({
    select: {
      name: true,
      storageFolderName: true,
      socialCopiesEnabled: true,
      project: { select: { storagePath: true } },
    },
    where: { project: { storagePath: { not: null } } },
  })

  const entries: FileEntry[] = []
  for (const album of albums) {
    const projectPath = album.project.storagePath
    const folderName = album.storageFolderName
    if (!projectPath || !folderName) continue

    const zipPaths = getAlbumZipStoragePaths({
      projectStoragePath: projectPath,
      albumFolderName: folderName,
      albumName: album.name,
    })

    const fullZipKey = normalizeKey(zipPaths.full)
    if (fullZipKey) entries.push({ key: fullZipKey, localPath: path.join(STORAGE_ROOT, fullZipKey) })

    if (album.socialCopiesEnabled) {
      const socialZipKey = normalizeKey(zipPaths.social)
      if (socialZipKey) entries.push({ key: socialZipKey, localPath: path.join(STORAGE_ROOT, socialZipKey) })
    }
  }
  return entries
}

async function collectKeysForCategory(
  category: BackupCategory,
  client: ReturnType<typeof getS3Client>,
  bucket: string,
): Promise<FileEntry[]> {
  switch (category) {
    case 'originalVideosBytes':
      return collectStoredKeys(['VIDEO'], ['ORIGINAL'])

    case 'videoPreviewsBytes': {
      const entries = await collectStoredKeys(
        ['VIDEO', 'VIDEO_ASSET'],
        ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL', 'PREVIEW_IMAGE', 'TIMELINE_VTT', 'TIMELINE_SPRITES'],
      )
      // Sprite sheets are stored as a directory prefix; enumerate actual files from S3
      const spriteEntries = await collectTimelineSpriteKeys(client, bucket)
      return [...entries, ...spriteEntries]
    }

    case 'videoAssetsBytes':
      return collectStoredKeys(['VIDEO_ASSET'], ['ORIGINAL'])

    case 'commentAttachmentsBytes':
      return collectStoredKeys(['COMMENT_FILE'], ['ORIGINAL'])

    case 'uploadsFilesBytes': {
      const entries = await collectStoredKeys(['SHARE_UPLOAD_FILE'], ['ORIGINAL'])
      // Upload folder markers are not in StoredFile
      const folders = await prisma.shareUploadFolder.findMany({ select: { storagePath: true } })
      for (const folder of folders) {
        const folderKey = normalizeKey(folder.storagePath)
        if (!folderKey) continue
        const markerKey = normalizeKey(`${folderKey}/${UPLOAD_FOLDER_MARKER}`)
        if (markerKey) entries.push({ key: markerKey, localPath: path.join(STORAGE_ROOT, markerKey) })
      }
      return entries
    }

    case 'originalPhotosBytes':
      return collectStoredKeys(['ALBUM_PHOTO'], ['ORIGINAL'])

    case 'photoZipBytes': {
      const entries = await collectStoredKeys(
        ['ALBUM_PHOTO', 'ALBUM'],
        ['SOCIAL', 'THUMBNAIL', 'ZIP_FULL', 'ZIP_SOCIAL'],
      )
      const previewEntries = await collectAlbumPhotoPreviewKeys()
      const zipEntries = await collectAlbumZipKeys()
      return [...entries, ...previewEntries, ...zipEntries]
    }

    case 'communicationsBytes':
      return collectStoredKeys(['PROJECT_EMAIL', 'PROJECT_EMAIL_ATTACHMENT'], ['RAW_EMAIL', 'ORIGINAL'])

    case 'projectFilesBytes':
      return collectStoredKeys(['PROJECT_FILE'], ['ORIGINAL'])

    case 'clientFilesBytes':
      return collectStoredKeys(['CLIENT_FILE'], ['ORIGINAL'])

    case 'userFilesBytes':
      return collectStoredKeys(['USER_FILE'], ['ORIGINAL'])

    case 'accountingFilesBytes':
      return collectAccountingKeys()

    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Main backup runner
// ---------------------------------------------------------------------------

/**
 * Run a backup of the specified S3 categories to local storage.
 *
 * Safe to call concurrently with normal app operation — it only reads from S3
 * and writes to local disk, never deleting anything.
 */
export async function runS3LocalBackup(
  categories: BackupCategory[],
  onProgress?: BackupProgressFn,
  options?: { dryRun?: boolean },
): Promise<S3LocalBackupResult> {
  const dryRun = options?.dryRun ?? false

  if (!isS3Mode()) {
    return {
      ok: false,
      dryRun,
      categories,
      totalKeys: 0,
      skipped: 0,
      downloaded: 0,
      wouldDownload: 0,
      failed: 0,
      errors: ['S3 mode is not active (STORAGE_PROVIDER is not "s3")'],
      durationMs: 0,
    }
  }

  const startMs = Date.now()
  const client = getS3Client()
  const bucket = getS3Bucket()

  let totalKeys = 0
  let skipped = 0
  let downloaded = 0
  let wouldDownload = 0
  let failed = 0
  const errors: string[] = []

  for (let catIdx = 0; catIdx < categories.length; catIdx++) {
    const category = categories[catIdx]
    let entries: FileEntry[]
    try {
      entries = await collectKeysForCategory(category, client, bucket)
    } catch (err: any) {
      const msg = `[${category}] Failed to collect keys: ${err?.message || err}`
      console.error('[S3-BACKUP]', msg)
      errors.push(msg)
      continue
    }

    totalKeys += entries.length

    // Notify caller that this category is starting
    if (onProgress) {
      await Promise.resolve(onProgress({
        currentCategory: category,
        categoryIndex: catIdx,
        totalCategories: categories.length,
        filesInCategory: entries.length,
        filesProcessed: 0,
        downloaded,
        skipped,
        failed,
      })).catch(() => {})
    }

    let filesProcessed = 0
    // Time-based throttle: at most one progress write per 3 seconds within a category
    let lastProgressMs = Date.now()

    for (const entry of entries) {
      try {
        const s3Size = await getS3Size(client, bucket, entry.key)
        if (s3Size === null) {
          // Object not found in S3 — nothing to back up, skip silently
          totalKeys--
          continue
        }

        if (await localFileSizeMatches(entry.localPath, s3Size)) {
          skipped++
        } else if (dryRun) {
          wouldDownload++
        } else {
          await downloadKey(client, bucket, entry.key, entry.localPath)
          downloaded++
        }
      } catch (err: any) {
        failed++
        const msg = `[${category}] ${entry.key}: ${err?.message || err}`
        console.error('[S3-BACKUP]', msg)
        if (errors.length < 100) errors.push(msg)
      }

      filesProcessed++

      // Throttled mid-category progress update
      if (onProgress) {
        const now = Date.now()
        if (now - lastProgressMs >= 3000) {
          lastProgressMs = now
          await Promise.resolve(onProgress({
            currentCategory: category,
            categoryIndex: catIdx,
            totalCategories: categories.length,
            filesInCategory: entries.length,
            filesProcessed,
            downloaded,
            skipped,
            failed,
          })).catch(() => {})
        }
      }
    }
  }

  const durationMs = Date.now() - startMs
  return {
    ok: failed === 0,
    dryRun,
    categories,
    totalKeys,
    skipped,
    downloaded,
    wouldDownload,
    failed,
    errors,
    durationMs,
  }
}

/** Load current backup settings from DB. Returns null if S3 is not active. */
export async function getS3LocalBackupSettings(): Promise<{
  enabled: boolean
  categories: BackupCategory[]
  lastRunAt: Date | null
  lastRunResult: string | null
  running: boolean
} | null> {
  if (!isS3Mode()) return null

  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      s3LocalBackupEnabled: true,
      s3LocalBackupCategories: true,
      s3LocalBackupLastRunAt: true,
      s3LocalBackupLastRunResult: true,
      s3LocalBackupRunning: true,
    },
  })

  if (!settings) return null

  let categories: BackupCategory[] = []
  try {
    const parsed = JSON.parse(settings.s3LocalBackupCategories || '[]')
    if (Array.isArray(parsed)) {
      categories = parsed.filter((c): c is BackupCategory =>
        ALL_BACKUP_CATEGORIES.includes(c as BackupCategory),
      )
    }
  } catch {
    // ignore parse errors
  }

  return {
    enabled: settings.s3LocalBackupEnabled,
    categories,
    lastRunAt: settings.s3LocalBackupLastRunAt,
    lastRunResult: settings.s3LocalBackupLastRunResult,
    running: settings.s3LocalBackupRunning,
  }
}

/** Build a human-readable summary string from a backup result. */
export function formatBackupResultSummary(result: S3LocalBackupResult): string {
  const dur = (result.durationMs / 1000).toFixed(1)
  const catList = result.categories.join(', ')
  if (result.dryRun) {
    if (!result.ok) {
      return `Dry run: ${result.wouldDownload ?? 0} would download, ${result.skipped} already up-to-date, ${result.failed} errors (${dur}s)`
    }
    return `Dry run: ${result.wouldDownload ?? 0} would download, ${result.skipped} already up-to-date (${dur}s)`
  }
  if (!result.ok) {
    return `Backup completed with errors (${result.failed} failed, ${result.downloaded} downloaded, ${result.skipped} skipped, ${dur}s). Categories: ${catList}`
  }
  return `Backup completed successfully — ${result.downloaded} downloaded, ${result.skipped} already up-to-date, in ${dur}s. Categories: ${catList}`
}
