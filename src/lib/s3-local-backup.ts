/**
 * S3 Local Backup
 *
 * Downloads files from S3 to local storage so that S3 can be disabled
 * at any time without missing files.  Files are saved to the same paths
 * they would occupy under normal "local" storage, so the application can
 * fall back to local mode transparently.
 *
 * Comparison strategy: size-based.  If the local file already exists and
 * its byte count matches the S3 object's size the file is skipped, avoiding
 * unnecessary downloads.
 *
 * Performance: the expensive part of a run is *deciding* what to download, not
 * the downloading — a mature library is nearly all already-backed-up files.  Two
 * things keep that decision cheap and independent of file count:
 *
 *   1. ONE bulk ListObjectsV2 sweep of the bucket up front builds a key -> size
 *      index (1000 keys per round trip, sizes included).  Every subsequent size
 *      check is an in-memory lookup instead of a per-file HeadObject, which used
 *      to cost one WAN round trip per file, serially, on every run.
 *   2. ONE paginated pass over the StoredFile registry buckets every row into its
 *      backup category, instead of re-scanning the whole table once per category.
 *
 * Local stat()s and downloads then run through small concurrency pools.
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
import { getAllStoredPaths, DIRECTORY_FILE_ROLES, type EntityType, type FileRole } from '@/lib/stored-file'

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
  /** Which half of the run is reporting: comparing sizes, or actually fetching bytes. */
  phase?: 'checking' | 'downloading'
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

/**
 * Hard ceiling on the bucket index. A key + size entry costs roughly 100 bytes, so the
 * default cap is on the order of 100 MB of RSS. Above it we abandon the index and fall
 * back to per-file size resolution rather than risk the worker OOM-ing.
 */
const S3_INDEX_MAX_KEYS = Number(process.env.S3_BACKUP_MAX_INDEX_KEYS) || 1_000_000

/**
 * Sweep the whole bucket into a `key -> size` map with one ListObjectsV2 per 1000 objects.
 *
 * This replaces one HeadObject per file per run. The listing is taken once, before any
 * comparison work: R2/S3 list-after-write is strongly consistent, so the only gap is
 * objects created *while* the run is in flight — which the previous implementation missed
 * too (keys are collected from the DB before any of them are checked). The next daily run
 * picks them up.
 *
 * Returns null if the bucket is larger than S3_INDEX_MAX_KEYS; callers must then fall back
 * to per-entry size resolution.
 */
async function buildS3Index(
  client: ReturnType<typeof getS3Client>,
  bucket: string,
): Promise<Map<string, number> | null> {
  const index = new Map<string, number>()
  let continuationToken: string | undefined
  let pages = 0

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    )
    pages++
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) index.set(obj.Key, obj.Size ?? 0)
    }
    if (index.size > S3_INDEX_MAX_KEYS) {
      console.warn(
        `[S3-BACKUP] Bucket exceeds ${S3_INDEX_MAX_KEYS} objects — falling back to per-file size lookups`,
      )
      return null
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
  } while (continuationToken)

  console.log(`[S3-BACKUP] Indexed ${index.size} objects from ${pages} listing request(s)`)
  return index
}

/**
 * How many entries are size-checked in parallel. These are local stat() calls (plus, only
 * in the no-index fallback, an S3 HeadObject), so this can be generous.
 */
const CHECK_CONCURRENCY = Math.max(1, Number(process.env.S3_BACKUP_CHECK_CONCURRENCY) || 16)

/**
 * How many files download in parallel. Deliberately much lower than CHECK_CONCURRENCY —
 * these are large media objects and the worker shares its uplink with normal traffic.
 */
const DOWNLOAD_CONCURRENCY = Math.max(1, Number(process.env.S3_BACKUP_DOWNLOAD_CONCURRENCY) || 4)

/**
 * Run `fn` over `items` with at most `concurrency` in flight.
 *
 * `fn` is expected to handle its own errors; if one escapes anyway, the pool does NOT
 * abandon the run. Letting the rejection out of `Promise.all` would resolve the caller
 * while sibling workers carried on unobserved and every unclaimed item was silently
 * dropped. Instead the failure is held, the remaining items are still processed, and the
 * first error is rethrown once every worker has finished — so nothing is skipped without
 * the caller hearing about it.
 *
 * Exported so `npm run test:smoke` can assert the ceiling and the no-abandonment guarantee.
 */
export async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  const limit = Math.min(concurrency, items.length)
  let next = 0
  let firstError: unknown
  let errorCount = 0

  const workers: Promise<void>[] = []
  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        for (;;) {
          const idx = next++
          if (idx >= items.length) return
          try {
            await fn(items[idx])
          } catch (err) {
            errorCount++
            if (firstError === undefined) firstError = err
          }
        }
      })(),
    )
  }
  await Promise.all(workers)

  if (firstError !== undefined) {
    const msg = firstError instanceof Error ? firstError.message : String(firstError)
    throw new Error(
      errorCount === 1
        ? `Pool task failed: ${msg}`
        : `${errorCount} pool tasks failed; first: ${msg}`,
      { cause: firstError },
    )
  }
}

/** True when an error (possibly wrapped by stream.pipeline / AbortSignal) is a disk-full. */
function isOutOfSpace(err: any): boolean {
  return err?.code === 'ENOSPC' || err?.cause?.code === 'ENOSPC'
}

/** True when S3 says the object simply isn't there. */
function isNotFound(err: any): boolean {
  return (
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.$metadata?.httpStatusCode === 404
  )
}

/**
 * Idle timeout for a single download: if no bytes are written to disk for this long
 * the transfer is considered stalled and aborted. Belt-and-braces on top of the S3
 * client's socket timeout — guarantees one wedged object can never hang the whole run.
 */
const DOWNLOAD_IDLE_TIMEOUT_MS = Number(process.env.S3_BACKUP_DOWNLOAD_IDLE_TIMEOUT_MS) || 120_000

/** Download one S3 key to the given local absolute path, creating parent dirs as needed. */
async function downloadKey(
  client: ReturnType<typeof getS3Client>,
  bucket: string,
  key: string,
  localAbsPath: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(localAbsPath), { recursive: true })
  const controller = new AbortController()
  const resp = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: controller.signal },
  )
  if (!resp.Body) throw new Error(`No body returned for key: ${key}`)
  const readable = resp.Body as unknown as Readable
  // Write to a temp file first so a partial download never replaces a good file.
  const tmpPath = `${localAbsPath}.s3backup-tmp`
  const writeStream = fs.createWriteStream(tmpPath)

  // Watchdog: poll bytes actually written and abort if no progress within the idle
  // window. Uses bytesWritten (not stream 'data' events) so it never perturbs the
  // pipe or risks dropping chunks.
  let lastBytes = 0
  let lastProgressAt = Date.now()
  const idleInterval = setInterval(() => {
    if (writeStream.bytesWritten > lastBytes) {
      lastBytes = writeStream.bytesWritten
      lastProgressAt = Date.now()
    } else if (Date.now() - lastProgressAt > DOWNLOAD_IDLE_TIMEOUT_MS) {
      controller.abort(new Error(`Download stalled: no bytes written for ${DOWNLOAD_IDLE_TIMEOUT_MS}ms`))
    }
  }, Math.min(DOWNLOAD_IDLE_TIMEOUT_MS, 15_000)).unref()

  try {
    await pipeline(readable, writeStream, { signal: controller.signal })
    await fs.promises.rename(tmpPath, localAbsPath)
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {})
    throw err
  } finally {
    clearInterval(idleInterval)
  }
}

// ---------------------------------------------------------------------------
// Key collection
// ---------------------------------------------------------------------------

/** Simple file record: S3 key + local absolute path to write to. */
interface FileEntry {
  key: string
  localPath: string
}

/**
 * Which backup category a StoredFile row belongs to, keyed `${entityType}|${fileRole}`.
 *
 * Every (entityType, fileRole) pair maps to at most one category, which is what lets the
 * entire registry be bucketed in ONE pass rather than re-scanned once per category.
 *
 * Directory roles (TIMELINE_SPRITES / HLS_SEGMENTS) are deliberately absent: their
 * storagePath is a prefix, not an object. Listing them here would produce one guaranteed
 * 404 per video on every run; they are expanded from the bucket listing instead, by
 * expandDirectoryPrefixes().
 */
const CATEGORY_ROLE_TABLE: Array<{
  category: BackupCategory
  entityTypes: EntityType[]
  fileRoles: FileRole[]
}> = [
  { category: 'originalVideosBytes', entityTypes: ['VIDEO'], fileRoles: ['ORIGINAL'] },
  {
    category: 'videoPreviewsBytes',
    entityTypes: ['VIDEO', 'VIDEO_ASSET'],
    fileRoles: [
      'PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL', 'PREVIEW_IMAGE',
      'TIMELINE_VTT', 'SUBTITLES_VTT', 'WAVEFORM_PEAKS', 'TRANSCRIPTION_AUDIO',
    ],
  },
  { category: 'videoAssetsBytes', entityTypes: ['VIDEO_ASSET'], fileRoles: ['ORIGINAL'] },
  { category: 'commentAttachmentsBytes', entityTypes: ['COMMENT_FILE'], fileRoles: ['ORIGINAL'] },
  { category: 'uploadsFilesBytes', entityTypes: ['SHARE_UPLOAD_FILE'], fileRoles: ['ORIGINAL'] },
  { category: 'originalPhotosBytes', entityTypes: ['ALBUM_PHOTO'], fileRoles: ['ORIGINAL'] },
  {
    category: 'photoZipBytes',
    entityTypes: ['ALBUM_PHOTO', 'ALBUM'],
    fileRoles: ['SOCIAL', 'THUMBNAIL', 'ZIP_FULL', 'ZIP_SOCIAL'],
  },
  {
    category: 'communicationsBytes',
    entityTypes: ['PROJECT_EMAIL', 'PROJECT_EMAIL_ATTACHMENT'],
    fileRoles: ['RAW_EMAIL', 'ORIGINAL'],
  },
  { category: 'projectFilesBytes', entityTypes: ['PROJECT_FILE'], fileRoles: ['ORIGINAL'] },
  { category: 'clientFilesBytes', entityTypes: ['CLIENT_FILE'], fileRoles: ['ORIGINAL'] },
  { category: 'userFilesBytes', entityTypes: ['USER_FILE'], fileRoles: ['ORIGINAL'] },
]

const CATEGORY_BY_ENTITY_ROLE: ReadonlyMap<string, BackupCategory> = (() => {
  const map = new Map<string, BackupCategory>()
  for (const { category, entityTypes, fileRoles } of CATEGORY_ROLE_TABLE) {
    for (const et of entityTypes) {
      for (const fr of fileRoles) {
        const composite = `${et}|${fr}`
        if (map.has(composite)) {
          // Programming error: two categories claiming the same rows would double-process them.
          throw new Error(`[S3-BACKUP] Duplicate category mapping for ${composite}`)
        }
        map.set(composite, category)
      }
    }
  }
  return map
})()

/** Entity types owned wholesale by a category, regardless of file role. */
const CATEGORY_BY_ENTITY_TYPE: ReadonlyMap<EntityType, BackupCategory> = new Map<EntityType, BackupCategory>([
  ['ACCOUNTING_ATTACHMENT', 'accountingFilesBytes'],
])

/**
 * The category that owns the files *inside* the directory-prefix roles. Sprites and HLS
 * segments are both preview-side artefacts, so they ride with video previews.
 */
const PREFIX_ROLE_CATEGORY: BackupCategory = 'videoPreviewsBytes'

interface RegistryScan {
  byCategory: Map<BackupCategory, FileEntry[]>
  /** Normalized directory prefixes (no trailing slash) awaiting expansion from S3. */
  directoryPrefixes: string[]
}

/**
 * Walk the StoredFile registry ONCE, bucketing every row into the category that owns it.
 *
 * Previously each category re-read the entire table and filtered in JS, so a 12-category
 * run shipped the whole registry across the network 13 times (the worker's Postgres is
 * remote). Rows for categories that were not requested are dropped here rather than built.
 */
async function scanStoredFiles(wanted: ReadonlySet<BackupCategory>): Promise<RegistryScan> {
  const byCategory = new Map<BackupCategory, FileEntry[]>()
  const directoryPrefixes: string[] = []
  const wantsPrefixRoles = wanted.has(PREFIX_ROLE_CATEGORY)

  const push = (category: BackupCategory, entry: FileEntry) => {
    const list = byCategory.get(category)
    if (list) list.push(entry)
    else byCategory.set(category, [entry])
  }

  let cursor: string | undefined
  do {
    const page = await getAllStoredPaths({ cursor, take: 5000 })
    for (const row of page.items) {
      if (!row.storagePath) continue

      if (DIRECTORY_FILE_ROLES.has(row.fileRole)) {
        if (wantsPrefixRoles) {
          const prefix = normalizeKey(row.storagePath)
          if (prefix) directoryPrefixes.push(prefix.replace(/\/+$/, ''))
        }
        continue
      }

      const category =
        CATEGORY_BY_ENTITY_ROLE.get(`${row.entityType}|${row.fileRole}`) ??
        CATEGORY_BY_ENTITY_TYPE.get(row.entityType)
      if (!category || !wanted.has(category)) continue

      const rel = normalizeKey(row.storagePath)
      if (!rel) continue

      if (category === 'accountingFilesBytes') {
        // Accounting lives under its own local root and the `accounting/` S3 prefix.
        // resolveAccountingFilePath() validates against traversal and throws on bad input —
        // skip the offending row rather than losing the whole scan.
        try {
          push(category, {
            key: toAccountingS3Key(rel),
            localPath: resolveAccountingFilePath(rel),
          })
        } catch {
          // ignore unusable accounting path
        }
        continue
      }

      push(category, { key: rel, localPath: path.join(STORAGE_ROOT, rel) })
    }
    cursor = page.nextCursor
  } while (cursor)

  return { byCategory, directoryPrefixes }
}

/**
 * Expand directory-prefix roles (sprite sheets, HLS bundles) into their actual child files
 * (sprite-*.jpg / master.m3u8 + init.mp4 + seg-*.m4s).
 *
 * With the bucket index in hand this is a single in-memory pass: for each object key, walk
 * its ancestor directories and see whether one is a registered prefix. That is O(depth) per
 * key, versus the previous one ListObjectsV2 round trip *per video* — the single biggest
 * cost on an HLS-heavy library.
 *
 * Exported so `npm run test:smoke` can assert the ancestor matching.
 */
export function expandDirectoryPrefixes(index: Map<string, number>, prefixes: string[]): FileEntry[] {
  if (prefixes.length === 0) return []
  const prefixSet = new Set(prefixes)
  const entries: FileEntry[] = []

  for (const key of index.keys()) {
    let slash = key.lastIndexOf('/')
    while (slash > 0) {
      if (prefixSet.has(key.slice(0, slash))) {
        entries.push({ key, localPath: path.join(STORAGE_ROOT, key) })
        break
      }
      slash = key.lastIndexOf('/', slash - 1)
    }
  }
  return entries
}

/** Fallback expansion when no bucket index is available: one listing per prefix. */
async function expandDirectoryPrefixesViaListing(
  client: ReturnType<typeof getS3Client>,
  bucket: string,
  prefixes: string[],
): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  for (const prefix of prefixes) {
    const objects = await listS3Keys(client, bucket, prefix).catch(() => [])
    for (const obj of objects) {
      entries.push({ key: obj.key, localPath: path.join(STORAGE_ROOT, obj.key) })
    }
  }
  return entries
}

/**
 * Upload-folder markers. These are zero-byte placeholders that keep an empty folder
 * visible; they have no StoredFile row, so they come straight from the folder table.
 */
async function collectUploadFolderMarkers(): Promise<FileEntry[]> {
  const folders = await prisma.shareUploadFolder.findMany({ select: { storagePath: true } })
  const entries: FileEntry[] = []
  for (const folder of folders) {
    const folderKey = normalizeKey(folder.storagePath)
    if (!folderKey) continue
    const markerKey = normalizeKey(`${folderKey}/${UPLOAD_FOLDER_MARKER}`)
    if (markerKey) entries.push({ key: markerKey, localPath: path.join(STORAGE_ROOT, markerKey) })
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

// ---------------------------------------------------------------------------
// Main backup runner
// ---------------------------------------------------------------------------

/**
 * Assemble the full entry list for a category from the one-pass registry scan plus the
 * handful of file kinds that have no StoredFile row of their own.
 */
async function buildCategoryEntries(
  category: BackupCategory,
  scan: RegistryScan,
  prefixEntries: FileEntry[],
): Promise<FileEntry[]> {
  const entries = [...(scan.byCategory.get(category) ?? [])]

  switch (category) {
    case 'videoPreviewsBytes':
      // Sprite / HLS children, already expanded from the bucket listing.
      entries.push(...prefixEntries)
      break
    case 'uploadsFilesBytes':
      entries.push(...(await collectUploadFolderMarkers()))
      break
    case 'photoZipBytes':
      entries.push(...(await collectAlbumZipKeys()))
      break
    default:
      break
  }

  return entries
}

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
  const wanted = new Set(categories)

  let totalKeys = 0
  let skipped = 0
  let downloaded = 0
  let wouldDownload = 0
  let failed = 0
  const errors: string[] = []

  const recordError = (msg: string) => {
    console.error('[S3-BACKUP]', msg)
    if (errors.length < 100) errors.push(msg)
  }

  // ---- Phase 0: one bucket sweep + one registry pass, shared by every category ----

  let index: Map<string, number> | null = null
  try {
    index = await buildS3Index(client, bucket)
  } catch (err: any) {
    // Not fatal: without the index we fall back to a per-file HeadObject, which is what
    // this did before the index existed — slow, but it asks S3 for the truth.
    recordError(`Bucket listing failed, falling back to per-file size lookups: ${err?.message || err}`)
    index = null
  }

  let scan: RegistryScan
  try {
    scan = await scanStoredFiles(wanted)
  } catch (err: any) {
    const msg = `Failed to read the file registry: ${err?.message || err}`
    console.error('[S3-BACKUP]', msg)
    return {
      ok: false,
      dryRun,
      categories,
      totalKeys: 0,
      skipped: 0,
      downloaded: 0,
      wouldDownload: 0,
      failed: 0,
      errors: [msg],
      durationMs: Date.now() - startMs,
    }
  }

  let prefixEntries: FileEntry[] = []
  if (scan.directoryPrefixes.length > 0) {
    try {
      prefixEntries = index
        ? expandDirectoryPrefixes(index, scan.directoryPrefixes)
        : await expandDirectoryPrefixesViaListing(client, bucket, scan.directoryPrefixes)
    } catch (err: any) {
      recordError(`Failed to expand sprite/HLS directories: ${err?.message || err}`)
    }
  }

  // A key is processed at most once per run even if two collectors reach for it.
  const seen = new Set<string>()

  // ---- Per-category work ----

  for (let catIdx = 0; catIdx < categories.length; catIdx++) {
    const category = categories[catIdx]

    let collected: FileEntry[]
    try {
      collected = await buildCategoryEntries(category, scan, prefixEntries)
    } catch (err: any) {
      recordError(`[${category}] Failed to collect keys: ${err?.message || err}`)
      continue
    }

    const entries: FileEntry[] = []
    for (const entry of collected) {
      const dedupeKey = `${entry.key}::${entry.localPath}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      entries.push(entry)
    }

    totalKeys += entries.length

    // ---- Progress plumbing (shared by both phases of this category) ----

    let filesProcessed = 0
    let lastProgressMs = Date.now()
    let progressInFlight = false

    const report = async (phase: 'checking' | 'downloading', forced = false) => {
      if (!onProgress) return
      const now = Date.now()
      // Throttle to one write per 3s, and never overlap two in-flight writes: the callback
      // persists to Postgres, which is a remote round trip from the worker.
      if (!forced && (progressInFlight || now - lastProgressMs < 3000)) return
      lastProgressMs = now
      progressInFlight = true
      try {
        await onProgress({
          currentCategory: category,
          categoryIndex: catIdx,
          totalCategories: categories.length,
          filesInCategory: entries.length,
          filesProcessed,
          downloaded,
          skipped,
          failed,
          phase,
        })
      } catch {
        // progress reporting must never break a backup
      } finally {
        progressInFlight = false
      }
    }

    await report('checking', true)

    // ---- Phase A: decide what needs downloading (no per-file network when indexed) ----

    const toDownload: FileEntry[] = []
    let missing = 0

    await runPool(entries, CHECK_CONCURRENCY, async (entry) => {
      try {
        // The index is authoritative. Without it, ask S3 per file rather than trusting
        // StoredFile.fileSize: that column is left untouched when a file is re-registered
        // without a size (buildStoredFileUpdateData treats undefined as "no change"), so a
        // file whose bytes changed can carry a stale count. Comparing against that would
        // silently mark an outdated local copy as up-to-date, permanently. The fallback is
        // rare by design, so its cost does not justify weakening the comparison.
        const s3Size = index
          ? index.get(entry.key) ?? null
          : await getS3Size(client, bucket, entry.key)

        if (s3Size === null) {
          // Not present in S3 — nothing to back up, skip silently (matches prior behaviour).
          missing++
          filesProcessed++
        } else if (await localFileSizeMatches(entry.localPath, s3Size)) {
          skipped++
          filesProcessed++
        } else if (dryRun) {
          wouldDownload++
          filesProcessed++
        } else {
          toDownload.push(entry)
          return // finalised in phase B
        }
      } catch (err: any) {
        failed++
        filesProcessed++
        recordError(`[${category}] ${entry.key}: ${err?.message || err}`)
      }
      await report('checking')
    })

    // Objects the registry knows about but S3 does not never counted towards the total.
    totalKeys -= missing

    // ---- Phase B: fetch, at a concurrency that respects the uplink ----

    if (toDownload.length > 0) {
      await report('downloading', true)

      let outOfSpace: Error | null = null
      let vanished = 0

      await runPool(toDownload, DOWNLOAD_CONCURRENCY, async (entry) => {
        if (outOfSpace) return
        try {
          await downloadKey(client, bucket, entry.key, entry.localPath)
          downloaded++
        } catch (err: any) {
          // A full disk is a whole-run fatal condition, not a per-file problem: every
          // remaining file would fail the same way. Stop the pool and surface it so the
          // operator frees space and re-runs.
          if (isOutOfSpace(err)) {
            outOfSpace = new Error(
              `No space left on device while writing ${entry.localPath} — backup aborted after ${downloaded} downloaded / ${skipped} up-to-date. Free disk space and re-run.`,
            )
            return
          }
          if (isNotFound(err)) {
            // The object is gone from S3 — it was in the index when the run started and
            // has been deleted since. Same silent skip the size-check path gives a key that
            // was never there, rather than a failure that would alert an operator about a
            // file there is nothing to do about.
            vanished++
          } else {
            failed++
            recordError(`[${category}] ${entry.key}: ${err?.message || err}`)
          }
        }
        filesProcessed++
        await report('downloading')
      })

      totalKeys -= vanished

      if (outOfSpace) {
        console.error('[S3-BACKUP]', (outOfSpace as Error).message)
        throw outOfSpace
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

/**
 * Ceiling on how long the `running` lock may be held before it's treated as stale.
 * A hung/killed run that never reset the flag self-heals after this window, so the
 * UI stops spinning and future scheduled runs are no longer skipped. Generous
 * (default 6h) — a normal run is minutes — but well under the 24h scheduling gap.
 */
export const BACKUP_STALE_LOCK_MS = Number(process.env.S3_BACKUP_STALE_LOCK_MS) || 6 * 60 * 60 * 1000

/** Load current backup settings from DB. Returns null if S3 is not active. */
export async function getS3LocalBackupSettings(): Promise<{
  enabled: boolean
  categories: BackupCategory[]
  lastRunAt: Date | null
  lastRunResult: string | null
  running: boolean
  startedAt: Date | null
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
      s3LocalBackupStartedAt: true,
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

  // Self-heal a stale lock: if it's been held past the ceiling, clear it so the UI
  // stops showing "Backing up…" and the next scheduled run isn't skipped. A missing
  // startedAt on a running lock is itself treated as stale (legacy / crashed set).
  let running = settings.s3LocalBackupRunning
  const startedAt = settings.s3LocalBackupStartedAt
  if (running) {
    const heldMs = startedAt ? Date.now() - startedAt.getTime() : Infinity
    if (heldMs > BACKUP_STALE_LOCK_MS) {
      running = false
      await prisma.settings.update({
        where: { id: 'default' },
        data: {
          s3LocalBackupRunning: false,
          s3LocalBackupStartedAt: null,
          s3LocalBackupLastRunResult:
            'Previous run did not finish cleanly (lock expired and was cleared automatically).',
        },
      }).catch(() => {})
    }
  }

  return {
    enabled: settings.s3LocalBackupEnabled,
    categories,
    lastRunAt: settings.s3LocalBackupLastRunAt,
    lastRunResult: settings.s3LocalBackupLastRunResult,
    running,
    startedAt,
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
