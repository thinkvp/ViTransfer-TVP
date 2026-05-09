import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { getFilePath } from '@/lib/storage'
import { isDropboxStoragePath, stripDropboxStoragePrefix } from '@/lib/storage-provider-dropbox'
import { S3Client, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'

export type S3MigrationConfig = {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

export type S3MigrationDryRunResult = {
  ok: true
  discoveredPaths: number
  existingLocalFiles: number
  missingLocalFiles: number
  totalBytes: number
  sampleKeys: string[]
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

function normalizeKey(rawPath: string): string | null {
  const trimmed = String(rawPath || '').trim()
  if (!trimmed) return null

  const normalized = isDropboxStoragePath(trimmed)
    ? stripDropboxStoragePrefix(trimmed)
    : trimmed

  const key = normalized.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
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

  const [
    videos,
    videoAssets,
    commentFiles,
    projectFiles,
    albumPhotos,
    projectEmails,
    projectEmailAttachments,
    clientFiles,
    userFiles,
    users,
    settings,
  ] = await Promise.all([
    prisma.video.findMany({
      select: {
        originalStoragePath: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        thumbnailPath: true,
        timelinePreviewVttPath: true,
        timelinePreviewSpritesPath: true,
      },
    }),
    prisma.videoAsset.findMany({ select: { storagePath: true } }),
    prisma.commentFile.findMany({ select: { storagePath: true } }),
    prisma.projectFile.findMany({ select: { storagePath: true } }),
    prisma.albumPhoto.findMany({ select: { storagePath: true, socialStoragePath: true } }),
    prisma.projectEmail.findMany({ select: { rawStoragePath: true } }),
    prisma.projectEmailAttachment.findMany({ select: { storagePath: true } }),
    prisma.clientFile.findMany({ select: { storagePath: true } }),
    prisma.userFile.findMany({ select: { storagePath: true } }),
    prisma.user.findMany({ select: { avatarPath: true } }),
    prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        companyLogoPath: true,
        darkLogoPath: true,
        companyFaviconPath: true,
      },
    }),
  ])

  for (const row of videos) {
    const candidates = [
      row.originalStoragePath,
      row.preview480Path,
      row.preview720Path,
      row.preview1080Path,
      row.thumbnailPath,
      row.timelinePreviewVttPath,
      row.timelinePreviewSpritesPath,
    ]
    for (const candidate of candidates) {
      const key = normalizeKey(candidate || '')
      if (key) keys.add(key)
    }
  }

  for (const row of videoAssets) {
    const key = normalizeKey(row.storagePath)
    if (key) keys.add(key)
  }

  for (const row of commentFiles) {
    const key = normalizeKey(row.storagePath)
    if (key) keys.add(key)
  }

  for (const row of projectFiles) {
    const key = normalizeKey(row.storagePath)
    if (key) keys.add(key)
  }

  for (const row of albumPhotos) {
    const key = normalizeKey(row.storagePath)
    if (key) keys.add(key)
    const socialKey = normalizeKey(row.socialStoragePath || '')
    if (socialKey) keys.add(socialKey)
  }

  for (const row of projectEmails) {
    const key = normalizeKey(row.rawStoragePath)
    if (key) keys.add(key)
  }

  for (const row of projectEmailAttachments) {
    const key = normalizeKey(row.storagePath)
    if (key) keys.add(key)
  }

  for (const row of clientFiles) {
    const key = normalizeKey(row.storagePath)
    if (key) keys.add(key)
  }

  for (const row of userFiles) {
    const key = normalizeKey(row.storagePath)
    if (key) keys.add(key)
  }

  for (const row of users) {
    const key = normalizeKey(row.avatarPath || '')
    if (key) keys.add(key)
  }

  const brandCandidates = [
    settings?.companyLogoPath,
    settings?.darkLogoPath,
    settings?.companyFaviconPath,
  ]
  for (const candidate of brandCandidates) {
    const key = normalizeKey(candidate || '')
    if (key) keys.add(key)
  }

  return keys
}

async function buildLocalManifest(): Promise<{ entries: LocalEntry[]; discoveredPaths: number; missingLocalFiles: number }> {
  const referencedKeys = await collectReferencedPaths()
  const entries: LocalEntry[] = []
  let missingLocalFiles = 0

  for (const key of referencedKeys) {
    let absPath: string
    try {
      absPath = getFilePath(key)
    } catch {
      missingLocalFiles++
      continue
    }

    let stats: fs.Stats
    try {
      stats = await fs.promises.stat(absPath)
    } catch {
      missingLocalFiles++
      continue
    }

    if (!stats.isFile()) {
      missingLocalFiles++
      continue
    }

    entries.push({ key, absPath, size: stats.size })
  }

  entries.sort((a, b) => a.key.localeCompare(b.key))

  return {
    entries,
    discoveredPaths: referencedKeys.size,
    missingLocalFiles,
  }
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

export async function dryRunLocalToS3Migration(): Promise<S3MigrationDryRunResult> {
  const { entries, discoveredPaths, missingLocalFiles } = await buildLocalManifest()
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0)

  return {
    ok: true,
    discoveredPaths,
    existingLocalFiles: entries.length,
    missingLocalFiles,
    totalBytes,
    sampleKeys: entries.slice(0, 20).map((entry) => entry.key),
  }
}

export async function startLocalToS3Migration(input: {
  config: Partial<S3MigrationConfig>
  overwriteExisting?: boolean
  concurrency?: number
}) {
  const state = getState()
  if (state.run && (state.run.status === 'PREPARING' || state.run.status === 'RUNNING')) {
    throw new Error('A migration is already running')
  }

  const config = getConfig(input.config)
  const overwriteExisting = input.overwriteExisting === true
  const concurrency = Math.max(1, Math.min(8, Number(input.concurrency || 3)))

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
            await client.send(new PutObjectCommand({
              Bucket: config.bucket,
              Key: next.key,
              Body: body,
              ContentLength: next.size,
              ContentType: 'application/octet-stream',
            }))

            run.filesCopied++
            run.bytesCopied += next.size
            run.filesProcessed++
          } catch (error: any) {
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
  return { ok: true, message: 'Cancellation requested' }
}

export function getLocalToS3MigrationStatus(): S3MigrationStatus {
  return makeStatus(getState().run)
}
