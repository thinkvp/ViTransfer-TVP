import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { downloadFile, getFilePath, uploadFileFromPath, deleteFile } from '../lib/storage'
import type { AlbumPhotoZipJob } from '../lib/queue'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '../lib/album-photo-zip'
import fs from 'fs'
import path from 'path'
import os from 'os'
import archiver from 'archiver'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { isS3Mode, s3FileExists, s3GetFileSize } from '@/lib/s3-storage'
import { registerStoredFile } from '@/lib/stored-file'
import { getStoredFilePath } from '@/lib/stored-file'

const ZIP_RETRY_DELAY_MS = 30_000

const DEBUG = process.env.DEBUG_WORKER === 'true'

async function writeZipFile(params: {
  outputStoragePath: string
  entries: Array<{ name: string; storagePath: string }>
}) {
  const { outputStoragePath, entries } = params

  // In S3 mode, write to a temp file first, then upload to R2.
  let outputPath: string
  if (isS3Mode()) {
    outputPath = path.join(os.tmpdir(), `album-zip-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
  } else {
    outputPath = getFilePath(outputStoragePath)
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
  }

  const tmpPath = `${outputPath}.tmp`
  await fs.promises.unlink(tmpPath).catch(() => {})

  const outStream = fs.createWriteStream(tmpPath)
  const archive = archiver('zip', { zlib: { level: 6 } })

  const done = new Promise<void>((resolve, reject) => {
    outStream.on('close', () => resolve())
    outStream.on('error', reject)
    archive.on('error', reject)
  })

  archive.pipe(outStream)

  for (const entry of entries) {
    try {
      // Check that the source file exists before appending.
      if (isS3Mode()) {
        const exists = await s3FileExists(entry.storagePath)
        if (!exists) {
          if (DEBUG) {
            console.warn('[WORKER DEBUG] Skipping missing ZIP entry:', entry)
          }
          continue
        }
      } else {
        const entryPath = getFilePath(entry.storagePath)
        const stats = await fs.promises.stat(entryPath).catch(() => null)
        if (!stats?.isFile()) {
          if (DEBUG) {
            console.warn('[WORKER DEBUG] Skipping missing ZIP entry:', entry)
          }
          continue
        }
      }

      const stream = await downloadFile(entry.storagePath)
      stream.on('error', (error) => {
        if (DEBUG) {
          console.warn('[WORKER DEBUG] ZIP entry stream failed:', entry, error)
        }
      })
      archive.append(stream, { name: entry.name })
    } catch (e) {
      if (DEBUG) {
        console.warn('[WORKER DEBUG] Failed to add ZIP entry:', entry, e)
      }
    }
  }

  await archive.finalize()
  await done

  await fs.promises.rename(tmpPath, outputPath)

  // In S3 mode, upload the locally-generated ZIP to R2 then remove the temp file.
  // uploadFileFromPath gives retries + multipart for large ZIPs (single PUTs can't
  // be retried after a transient R2 error and are capped at ~5 GiB).
  if (isS3Mode()) {
    const stats = await fs.promises.stat(outputPath)
    await uploadFileFromPath(outputStoragePath, outputPath, stats.size, 'application/zip')
    await fs.promises.unlink(outputPath).catch(() => {})
  }
}

export async function processAlbumPhotoZip(job: Job<AlbumPhotoZipJob>) {
  const { albumId, variant } = job.data

  const stableJobId = getAlbumZipJobId({ albumId, variant })

  if (DEBUG) {
    console.log('[WORKER DEBUG] Album photo ZIP job data:', JSON.stringify(job.data, null, 2))
  }

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      projectId: true,
      name: true,
      storageFolderName: true,
      socialCopiesEnabled: true,
      project: {
        select: {
          title: true,
          companyName: true,
          client: { select: { name: true } },
        },
      },
    },
  })

  if (!album) {
    console.warn(`[WORKER] Album not found for ZIP generation: ${albumId}`)
    return
  }

  const albumRowId = album.id
  const projectId = album.projectId
  const albumName = album.name
  const projectTitle = album.project.title
  const projectStoragePath = buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', projectTitle)
  const albumFolderName = album.storageFolderName || albumName

  const zipArgs = { projectStoragePath, albumFolderName, albumName }

  // Keep album-level status in sync with background work.
  await prisma.album.update({ where: { id: albumRowId }, data: { status: 'PROCESSING' } }).catch(() => {})

  // Skip social ZIP generation when social downloads are disabled for this album.
  if (variant === 'social' && !album.socialCopiesEnabled) {
    if (DEBUG) {
      console.log(`[WORKER DEBUG] Skipping social ZIP generation; social downloads disabled for album ${albumId}`)
    }
    return
  }

  async function maybeMarkAlbumReady() {
    try {
      const uploadingCount = await prisma.albumPhoto.count({ where: { albumId, status: 'UPLOADING' } })
      if (uploadingCount > 0) return

      const pendingSocialCount = await prisma.albumPhoto.count({
        where: {
          albumId,
          status: 'READY',
          OR: [{ socialStatus: 'PENDING' }, { socialStatus: 'PROCESSING' }],
        },
      })
      // Social derivatives are always generated (used as previews); wait for them.
      if (pendingSocialCount > 0) return

      const fullZipStoragePath = getAlbumZipStoragePath({ ...zipArgs, variant: 'full' })
      const socialZipStoragePath = getAlbumZipStoragePath({ ...zipArgs, variant: 'social' })

      let fullExists: boolean
      let socialExists: boolean
      if (isS3Mode()) {
        ;[fullExists, socialExists] = await Promise.all([
          s3FileExists(fullZipStoragePath),
          s3FileExists(socialZipStoragePath),
        ])
      } else {
        fullExists = fs.existsSync(getFilePath(fullZipStoragePath))
        socialExists = fs.existsSync(getFilePath(socialZipStoragePath))
      }

      // Consider an empty album READY even if zips do not exist.
      const anyReadyPhotos = await prisma.albumPhoto.count({ where: { albumId, status: 'READY' } })
      if (anyReadyPhotos === 0) {
        await prisma.album.update({ where: { id: albumRowId }, data: { status: 'READY' } })
        return
      }

      // Only require a social ZIP when social downloads are enabled and at least one usable social derivative exists.
      // If all social derivatives errored, the social ZIP will never be created —
      // don't let that block the album from becoming READY.
      const socialUsableCount = await prisma.albumPhoto.count({
        where: { albumId, status: 'READY', socialStatus: 'READY' },
      })
      const needSocialZip = album!.socialCopiesEnabled && socialUsableCount > 0

      if (fullExists && (!needSocialZip || socialExists)) {
        await prisma.album.update({ where: { id: albumRowId }, data: { status: 'READY' } })
      }
    } catch {
      // ignore
    }
  }

  // Avoid zipping while uploads are still in progress.
  const uploadingCount = await prisma.albumPhoto.count({
    where: { albumId, status: 'UPLOADING' },
  })

  if (uploadingCount > 0) {
    if (DEBUG) {
      console.log(`[WORKER DEBUG] Skipping ZIP generation; ${uploadingCount} uploads still in progress for album ${albumId}`)
    }

    // Re-schedule so we eventually generate after the batch completes.
    try {
      const { getAlbumPhotoZipQueue } = await import('../lib/queue')
      const q = getAlbumPhotoZipQueue()
      await q.remove(stableJobId).catch(() => {})
      await q.add('generate-album-zip', { albumId, variant }, { jobId: stableJobId, delay: ZIP_RETRY_DELAY_MS }).catch(() => {})
    } catch {
      // ignore
    }
    return
  }

  let photos = await prisma.albumPhoto.findMany({
    where: { albumId, status: 'READY' },
    select: { id: true, fileName: true, socialStatus: true },
    orderBy: { createdAt: 'asc' },
  })

  if (photos.length === 0) {
    // Nothing to zip; ensure any old zip is removed.
    const zipStoragePath = getAlbumZipStoragePath({
      ...zipArgs,
      variant,
    })
    await deleteFile(zipStoragePath).catch(() => {})

    const zipRole = variant === 'social' ? 'ZIP_SOCIAL' as const : 'ZIP_FULL' as const
    const prevFile = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: album.id, fileRole: zipRole } },
      select: { fileSize: true },
    })
    const prevSize = prevFile?.fileSize ?? BigInt(0)
    if (prevSize > BigInt(0)) {
      try {
        await prisma.storedFile.update({
          where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: album.id, fileRole: zipRole } },
          data: { fileSize: BigInt(0) },
        })
        await adjustProjectTotalBytes(album.projectId, prevSize * BigInt(-1))
      } catch {
        // Best-effort: daily reconciliation will restore correctness.
      }
    }

    await maybeMarkAlbumReady()
    return
  }

  const zipStoragePath = getAlbumZipStoragePath({
    ...zipArgs,
    variant,
  })

  if (variant === 'social') {
    // Separate photos still being processed (wait for them) from permanently failed ones (skip them).
    const stillProcessing = photos.filter((p) => p.socialStatus === 'PENDING' || p.socialStatus === 'PROCESSING')
    if (stillProcessing.length > 0) {
      // Social derivatives still in progress — reschedule and wait.
      if (DEBUG) {
        console.log(`[WORKER DEBUG] Social ZIP waiting; ${stillProcessing.length} photos still processing social derivatives for album ${albumId}`)
      }

      try {
        const { getAlbumPhotoZipQueue } = await import('../lib/queue')
        const q = getAlbumPhotoZipQueue()
        await q.remove(stableJobId).catch(() => {})
        await q.add('generate-album-zip', { albumId, variant }, { jobId: stableJobId, delay: ZIP_RETRY_DELAY_MS }).catch(() => {})
      } catch {
        // ignore
      }
      return
    }

    // Only include photos with a usable social derivative; skip errored ones.
    const socialReadyIds = new Set<string>()
    for (const p of photos) {
      if (p.socialStatus === 'READY') {
        const socialPath = await getStoredFilePath('ALBUM_PHOTO', p.id, 'SOCIAL')
        if (socialPath) socialReadyIds.add(p.id)
      }
    }
    const socialReady = photos.filter((p) => socialReadyIds.has(p.id))
    if (socialReady.length === 0) {
      // All social derivatives failed — no ZIP to create, but still evaluate readiness.
      await maybeMarkAlbumReady()
      return
    }

    // Build ZIP from only the social-ready subset.
    photos = socialReady
  }

  const fileRole = variant === 'social' ? 'SOCIAL' as const : 'ORIGINAL' as const
  const entries = await Promise.all(photos.map(async (p) => {
    const storagePath = await getStoredFilePath('ALBUM_PHOTO', p.id, fileRole)
    if (!storagePath) return null
    return {
      name: p.fileName,
      storagePath,
    }
  })).then(results => results.filter((e): e is NonNullable<typeof e> => e !== null))

  await writeZipFile({
    outputStoragePath: zipStoragePath,
    entries,
  })

  // Persist ZIP size and adjust project totals by the delta.
  try {
    let newSize = BigInt(0)
    if (isS3Mode()) {
      const size = await s3GetFileSize(zipStoragePath)
      newSize = BigInt(Math.max(0, Number(size || 0)))
    } else {
      const zipFullPath = getFilePath(zipStoragePath)
      const zipStats = await fs.promises.stat(zipFullPath)
      newSize = BigInt(zipStats.size)
    }

    const zipRole = variant === 'social' ? 'ZIP_SOCIAL' as const : 'ZIP_FULL' as const

    const prevFile = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'ALBUM', entityId: albumId, fileRole: zipRole } },
      select: { fileSize: true },
    })
    const prevSize = prevFile?.fileSize ?? BigInt(0)

    // NOTE: Legacy Album ZIP size columns dropped — StoredFile is the source of truth

    // Register in StoredFile registry
    registerStoredFile({
      entityType: 'ALBUM', entityId: albumId, fileRole: zipRole,
      storagePath: zipStoragePath, fileSize: newSize, status: 'READY',
    }).catch((err) => console.error(`[WORKER] StoredFile ${variant} ZIP register failed for album ${albumId}:`, err))

    await adjustProjectTotalBytes(album.projectId, newSize - prevSize)
  } catch {
    // Best-effort: if this fails, totals may be stale until daily reconciliation.
  }

  console.log(`[WORKER] Generated ${variant} album ZIP: ${albumId}`)

  await maybeMarkAlbumReady()

}
