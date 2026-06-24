import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { getAlbumZipStoragePaths } from '@/lib/album-photo-zip'
import { getFilePath } from '@/lib/storage'
import { getAllStoredPaths } from '@/lib/stored-file'
import { resolveAccountingFilePath, toAccountingS3Key } from '@/lib/accounting/file-storage'
import { S3Client, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

const UPLOAD_FOLDER_MARKER = '.vitransfer_folder'

const MB = 1024 * 1024
const MAX_SINGLE_PUT_OBJECT_BYTES = 5 * 1024 * 1024 * 1024
const DEFAULT_MULTIPART_THRESHOLD_MB = 64
const DEFAULT_MULTIPART_PART_SIZE_MB = 64
const DEFAULT_MULTIPART_QUEUE_SIZE = 4
const MIN_MULTIPART_THRESHOLD_MB = 5
const MAX_MULTIPART_THRESHOLD_MB = 10240
const MIN_MULTIPART_PART_SIZE_MB = 5
const MAX_MULTIPART_PART_SIZE_MB = 512
const MIN_MULTIPART_QUEUE_SIZE = 1
const MAX_MULTIPART_QUEUE_SIZE = 8

export type S3MigrationConfig = {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

export type S3MigrationDryRunResult = {
  ok: true, discoveredPaths: number
  existingLocalFiles: number
  missingLocalFiles: number
  totalBytes: number
  /** Set when S3 credentials were provided: files that already exist in S3 at the correct size and would be skipped. */
  alreadyInS3?: number
  /** Set when S3 credentials were provided: files that do not yet exist in S3 and would actually be uploaded. */
  wouldCopy?: number
  /** Bytes for the wouldCopy set only (0 if all already in S3). */
  wouldCopyBytes?: number
  sampleKeys: string[]
  missingKeys: string[]
}

export type S3MigrationRunStatus = 'PREPARING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export type S3MigrationStatus = {
  active: boolean
  run: {
    id: string
    status: S3MigrationRunStatus
    startedAt: string
    finishedAt: string | null
    currentKey: string | null
    filesTotal: number
    filesProcessed: number
    filesCopied: number
    filesSkipped: number
    filesFailed: number
    bytesTotal: number
    bytesCopied: number
    errors: Array<{ key: string; error: string }>
    speedBytesPerSecond: number
    etaSeconds: number | null
    progressPercent: number
    overwriteExisting: boolean
    concurrency: number
    multipartThresholdMB: number
    multipartPartSizeMB: number
    multipartQueueSize: number
  } | null
}

type LocalEntry = {
  key: string
  absPath: string
  size: number
}

type MigrationRun = {
  id: string
  status: S3MigrationRunStatus
  startedAt: Date
  finishedAt: Date | null
  currentKey: string | null
  filesTotal: number
  filesProcessed: number
  filesCopied: number
  filesSkipped: number
  filesFailed: number
  bytesTotal: number
  bytesCopied: number
  errors: Array<{ key: string; error: string }>
  cancelRequested: boolean
  overwriteExisting: boolean
  concurrency: number
  multipartThresholdMB: number
  multipartPartSizeMB: number
  multipartQueueSize: number
  activeAbortControllers: Set<AbortController>
  activeMultipartUploads: Set<Upload>
}

type MigrationState = {
  run: MigrationRun | null
}

const g = globalThis as typeof globalThis & {
  __localToS3MigrationState?: MigrationState
}

function getState(): MigrationState {
  if (!g.__localToS3MigrationState) {
    g.__localToS3MigrationState = { run: null }
  }
  return g.__localToS3MigrationState
}

function nowIso() {
  return new Date().toISOString()
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function isAbortError(error: any): boolean {
  const name = String(error?.name || '')
  const message = String(error?.message || '').toLowerCase()
  return (
    name === 'AbortError' ||
    name === 'RequestAbortedError' ||
    message.includes('abort') ||
    message.includes('aborted') ||
    message.includes('canceled') ||
    message.includes('cancelled')
  )
}

function normalizeKey(rawPath: string): string | null {
  const trimmed = String(rawPath || '').trim()
  if (!trimmed) return null

  const key = trimmed.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!key) return null
  if (key === '.tus-tmp' || key.startsWith('.tus-tmp/')) return null
  return key
}

function makeClient(config: S3MigrationConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region || 'auto',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED' as any,
    responseChecksumValidation: 'WHEN_REQUIRED' as any,
  })
}

function getConfig(input: Partial<S3MigrationConfig>): S3MigrationConfig {
  const endpoint = String(input.endpoint || '').trim()
  const bucket = String(input.bucket || '').trim()
  const region = String(input.region || 'auto').trim() || 'auto'
  const accessKeyId = String(input.accessKeyId || '').trim()
  const secretAccessKey = String(input.secretAccessKey || '').trim()
  const forcePathStyle = input.forcePathStyle !== false

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing required S3 fields: endpoint, bucket, access key id, and secret access key are required')
  }

  return {
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
  }
}

async function collectReferencedPaths(): Promise<Set<string>> {
  const keys = new Set<string>()

  // Use StoredFile as the single source of truth for all file paths (paginated).
  // Replaces ~250 lines of per-entity-table queries.
  let cursor: string | undefined
  do {
    const page = await getAllStoredPaths({ cursor, take: 5000 })
    for (const entry of page.items) {
      if (!entry.storagePath) continue

      // TIMELINE_SPRITES paths are directories; enumerate their children later
      // via buildMainLocalEntries, which detects directories.
      const key = normalizeKey(entry.storagePath)
      if (key) keys.add(key)
    }
    cursor = page.nextCursor
  } while (cursor)

  // Upload folder markers are not in StoredFile — collect separately
  const shareUploadFolders = await prisma.$queryRaw<Array<{ storagePath: string | null }>>`SELECT "storagePath" FROM "ShareUploadFolder"`
  for (const folder of shareUploadFolders) {
    const folderKey = normalizeKey(folder.storagePath || '')
    if (!folderKey) continue
    const markerKey = normalizeKey(`${folderKey}/${UPLOAD_FOLDER_MARKER}`)
    if (markerKey) keys.add(markerKey)
  }

  return keys
}

/**
 * Build local entries for accounting attachments.
 * These live under ACCOUNTING_STORAGE_ROOT and are uploaded to S3 under the 'accounting/' prefix.
 */
async function buildAccountingLocalEntries(): Promise<{ entries: LocalEntry[]; discoveredPaths: number; missingLocalFiles: number; missingKeys: string[] }> {
  const storedFiles = await prisma.storedFile.findMany({
    where: { entityType: 'ACCOUNTING_ATTACHMENT' },
    select: { entityId: true, storagePath: true, fileSize: true },
  })
  const pathMap = new Map(storedFiles.map(s => [s.entityId, s]))
  const entries: LocalEntry[] = []
  let missingLocalFiles = 0
  const missingKeys: string[] = []

  for (const [entityId, sf] of pathMap) {
    const relPath = sf.storagePath?.trim()
    if (!relPath) continue

    const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    let absPath: string
    let key: string
    try {
      absPath = resolveAccountingFilePath(relPath)
      key = toAccountingS3Key(normalized)
    } catch {
      missingLocalFiles++
      missingKeys.push(toAccountingS3Key(normalized))
      continue
    }

    let stats: fs.Stats
    try {
      stats = await fs.promises.stat(absPath)
    } catch {
      missingLocalFiles++
      missingKeys.push(key)
      continue
    }

    if (!stats.isFile()) {
      missingLocalFiles++
      missingKeys.push(key)
      continue
    }

    entries.push({ key, absPath, size: stats.size })
  }

  return { entries, discoveredPaths: storedFiles.length, missingLocalFiles, missingKeys }
}

async function buildLocalManifest(): Promise<{ entries: LocalEntry[]; discoveredPaths: number; missingLocalFiles: number; missingKeys: string[] }> {
  const referencedKeys = await collectReferencedPaths()
  const [mainEntries, accountingResult] = await Promise.all([
    buildMainLocalEntries(referencedKeys),
    buildAccountingLocalEntries(),
  ])

  const entries = [...mainEntries.entries, ...accountingResult.entries]
  entries.sort((a, b) => a.key.localeCompare(b.key))

  return {
    entries,
    discoveredPaths: referencedKeys.size + accountingResult.discoveredPaths,
    missingLocalFiles: mainEntries.missingLocalFiles + accountingResult.missingLocalFiles,
    missingKeys: [...mainEntries.missingKeys, ...accountingResult.missingKeys],
  }
}

async function buildMainLocalEntries(referencedKeys: Set<string>): Promise<{ entries: LocalEntry[]; missingLocalFiles: number; missingKeys: string[] }> {
  const entries: LocalEntry[] = []
  let missingLocalFiles = 0
  const missingKeys: string[] = []

  for (const key of referencedKeys) {
    let absPath: string
    try {
      absPath = getFilePath(key)
    } catch {
      missingLocalFiles++
      missingKeys.push(key)
      continue
    }

    let stats: fs.Stats
    try {
      stats = await fs.promises.stat(absPath)
    } catch {
      missingLocalFiles++
      missingKeys.push(key)
      continue
    }

    if (stats.isDirectory()) {
      // Some DB paths (e.g. timelinePreviewSpritesPath) point to a directory
      // containing multiple derived files. Enumerate immediate children so
      // every file inside gets uploaded to S3.
      try {
        const children = await fs.promises.readdir(absPath)
        for (const child of children) {
          const childAbsPath = path.join(absPath, child)
          let childStats: fs.Stats
          try {
            childStats = await fs.promises.stat(childAbsPath)
          } catch {
            continue
          }
          if (!childStats.isFile()) continue
          const childKey = `${key}/${child}`
          entries.push({ key: childKey, absPath: childAbsPath, size: childStats.size })
        }
      } catch {
        // If readdir fails, count as missing rather than crashing the whole run.
        missingLocalFiles++
        missingKeys.push(key)
      }
      continue
    }

    if (!stats.isFile()) {
      missingLocalFiles++
      missingKeys.push(key)
      continue
    }

    entries.push({ key, absPath, size: stats.size })
  }

  return { entries, missingLocalFiles, missingKeys }
}

async function objectMatchesSize(client: S3Client, bucket: string, key: string, size: number): Promise<boolean> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return Number(head.ContentLength || 0) === size
  } catch (error: any) {
    const code = Number(error?.$metadata?.httpStatusCode || 0)
    if (code === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return false
    throw error
  }
}

function makeStatus(run: MigrationRun | null): S3MigrationStatus {
  if (!run) {
    return { active: false, run: null }
  }

  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - run.startedAt.getTime()) / 1000))
  const speedBytesPerSecond = run.bytesCopied > 0 ? Math.floor(run.bytesCopied / elapsedSeconds) : 0
  const remainingBytes = Math.max(0, run.bytesTotal - run.bytesCopied)
  const etaSeconds = speedBytesPerSecond > 0 ? Math.ceil(remainingBytes / speedBytesPerSecond) : null
  const progressPercent = run.bytesTotal > 0
    ? Math.max(0, Math.min(100, Math.round((run.bytesCopied / run.bytesTotal) * 1000) / 10))
    : 0

  return {
    active: run.status === 'PREPARING' || run.status === 'RUNNING',
    run: {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      currentKey: run.currentKey,
      filesTotal: run.filesTotal,
      filesProcessed: run.filesProcessed,
      filesCopied: run.filesCopied,
      filesSkipped: run.filesSkipped,
      filesFailed: run.filesFailed,
      bytesTotal: run.bytesTotal,
      bytesCopied: run.bytesCopied,
      errors: run.errors.slice(0, 50),
      speedBytesPerSecond,
      etaSeconds,
      progressPercent,
      overwriteExisting: run.overwriteExisting,
      concurrency: run.concurrency,
      multipartThresholdMB: run.multipartThresholdMB,
      multipartPartSizeMB: run.multipartPartSizeMB,
      multipartQueueSize: run.multipartQueueSize,
    },
  }
}

export async function validateS3MigrationConfig(input: Partial<S3MigrationConfig>) {
  const config = getConfig(input)
  const client = makeClient(config)

  await client.send(new ListObjectsV2Command({
    Bucket: config.bucket,
    MaxKeys: 1,
  }))

  return {
    ok: true,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
  }
}

async function checkEntriesAgainstS3(
  entries: LocalEntry[],
  client: S3Client,
  bucket: string,
  concurrency = 20,
): Promise<boolean[]> {
  const results = new Array<boolean>(entries.length).fill(false)
  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const i = nextIndex++
      if (i >= entries.length) return
      results[i] = await objectMatchesSize(client, bucket, entries[i].key, entries[i].size)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length || 1) }, () => worker()))
  return results
}

export async function dryRunLocalToS3Migration(credentials?: Partial<S3MigrationConfig>): Promise<S3MigrationDryRunResult> {
  const { entries, discoveredPaths, missingLocalFiles, missingKeys } = await buildLocalManifest()
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0)

  if (credentials) {
    let config: S3MigrationConfig | undefined
    try {
      config = getConfig(credentials)
    } catch {
      // Incomplete credentials — skip S3 check and fall through to local-only result
    }

    if (config) {
      const client = makeClient(config)
      const matchResults = await checkEntriesAgainstS3(entries, client, config.bucket)
      const alreadyInS3 = matchResults.filter(Boolean).length
      const wouldCopyEntries = entries.filter((_, i) => !matchResults[i])
      const wouldCopyBytes = wouldCopyEntries.reduce((total, entry) => total + entry.size, 0)

      return {
        ok: true,
        discoveredPaths,
        existingLocalFiles: entries.length,
        missingLocalFiles,
        totalBytes,
        alreadyInS3,
        wouldCopy: wouldCopyEntries.length,
        wouldCopyBytes,
        sampleKeys: wouldCopyEntries.slice(0, 20).map((entry) => entry.key),
        missingKeys,
      }
    }
  }

  return {
    ok: true,
    discoveredPaths,
    existingLocalFiles: entries.length,
    missingLocalFiles,
    totalBytes,
    sampleKeys: entries.slice(0, 20).map((entry) => entry.key),
    missingKeys,
  }
}

export async function startLocalToS3Migration(input: {
  config: Partial<S3MigrationConfig>
  overwriteExisting?: boolean
  concurrency?: number
  multipartThresholdMB?: number
  multipartPartSizeMB?: number
  multipartQueueSize?: number
}) {
  const state = getState()
  if (state.run && (state.run.status === 'PREPARING' || state.run.status === 'RUNNING')) {
    throw new Error('A migration is already running')
  }

  const config = getConfig(input.config)
  const overwriteExisting = input.overwriteExisting === true
  const concurrency = Math.max(1, Math.min(8, Number(input.concurrency || 3)))
  const multipartThresholdMB = clampInt(
    input.multipartThresholdMB,
    MIN_MULTIPART_THRESHOLD_MB,
    MAX_MULTIPART_THRESHOLD_MB,
    DEFAULT_MULTIPART_THRESHOLD_MB,
  )
  const multipartPartSizeMB = clampInt(
    input.multipartPartSizeMB,
    MIN_MULTIPART_PART_SIZE_MB,
    MAX_MULTIPART_PART_SIZE_MB,
    DEFAULT_MULTIPART_PART_SIZE_MB,
  )
  const multipartQueueSize = clampInt(
    input.multipartQueueSize,
    MIN_MULTIPART_QUEUE_SIZE,
    MAX_MULTIPART_QUEUE_SIZE,
    DEFAULT_MULTIPART_QUEUE_SIZE,
  )

  const run: MigrationRun = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    status: 'PREPARING',
    startedAt: new Date(),
    finishedAt: null,
    currentKey: null,
    filesTotal: 0,
    filesProcessed: 0,
    filesCopied: 0,
    filesSkipped: 0,
    filesFailed: 0,
    bytesTotal: 0,
    bytesCopied: 0,
    errors: [],
    cancelRequested: false,
    overwriteExisting,
    concurrency,
    multipartThresholdMB,
    multipartPartSizeMB,
    multipartQueueSize,
    activeAbortControllers: new Set(),
    activeMultipartUploads: new Set(),
  }

  state.run = run

  void (async () => {
    try {
      const { entries } = await buildLocalManifest()
      run.filesTotal = entries.length
      run.bytesTotal = entries.reduce((total, entry) => total + entry.size, 0)
      run.status = 'RUNNING'

      const client = makeClient(config)
      let index = 0

      async function workerLoop() {
        while (true) {
          if (run.cancelRequested) return
          const next = entries[index]
          index++
          if (!next) return

          run.currentKey = next.key

          try {
            if (!run.overwriteExisting) {
              const matches = await objectMatchesSize(client, config.bucket, next.key, next.size)
              if (matches) {
                run.filesSkipped++
                run.filesProcessed++
                continue
              }
            }

            const body = fs.createReadStream(next.absPath)
            const shouldUseMultipart =
              next.size > MAX_SINGLE_PUT_OBJECT_BYTES ||
              next.size >= run.multipartThresholdMB * MB

            if (shouldUseMultipart) {
              const upload = new Upload({
                client,
                params: {
                  Bucket: config.bucket,
                  Key: next.key,
                  Body: body,
                  ContentType: 'application/octet-stream',
                },
                partSize: run.multipartPartSizeMB * MB,
                queueSize: run.multipartQueueSize,
                leavePartsOnError: false,
              })

              run.activeMultipartUploads.add(upload)
              try {
                if (run.cancelRequested) {
                  await upload.abort()
                  return
                }
                await upload.done()
              } finally {
                run.activeMultipartUploads.delete(upload)
              }
            } else {
              const abortController = new AbortController()
              run.activeAbortControllers.add(abortController)
              try {
                if (run.cancelRequested) {
                  abortController.abort()
                  return
                }
                await client.send(
                  new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: next.key,
                    Body: body,
                    ContentLength: next.size,
                    ContentType: 'application/octet-stream',
                  }),
                  { abortSignal: abortController.signal },
                )
              } finally {
                run.activeAbortControllers.delete(abortController)
              }
            }

            run.filesCopied++
            run.bytesCopied += next.size
            run.filesProcessed++
          } catch (error: any) {
            if (run.cancelRequested && isAbortError(error)) {
              run.filesProcessed++
              continue
            }
            run.filesFailed++
            run.filesProcessed++
            if (run.errors.length < 50) {
              run.errors.push({ key: next.key, error: error?.message || 'Unknown error' })
            }
          }
        }
      }

      const workers = Array.from({ length: run.concurrency }, () => workerLoop())
      await Promise.all(workers)

      run.currentKey = null
      run.finishedAt = new Date()
      if (run.cancelRequested) {
        run.status = 'CANCELLED'
      } else if (run.filesFailed > 0) {
        run.status = 'FAILED'
      } else {
        run.status = 'COMPLETED'
      }
    } catch (error: any) {
      run.currentKey = null
      run.finishedAt = new Date()
      run.status = 'FAILED'
      if (run.errors.length < 50) {
        run.errors.push({ key: run.currentKey || 'migration', error: error?.message || 'Unknown error' })
      }
    }
  })()

  return makeStatus(run)
}

export function cancelLocalToS3Migration() {
  const state = getState()
  const run = state.run
  if (!run || (run.status !== 'PREPARING' && run.status !== 'RUNNING')) {
    return { ok: false, message: 'No running migration to cancel' }
  }

  run.cancelRequested = true
  for (const abortController of run.activeAbortControllers) {
    abortController.abort()
  }
  for (const upload of run.activeMultipartUploads) {
    void upload.abort()
  }
  return { ok: true, message: 'Cancellation requested' }
}

export function getLocalToS3MigrationStatus(): S3MigrationStatus {
  return makeStatus(getState().run)
}
