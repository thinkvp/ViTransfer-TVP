import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { downloadFile, getFilePath } from '../lib/storage'
import type { AlbumPhotoZipJob } from '../lib/queue'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '../lib/album-photo-zip'
import fs from 'fs'
import path from 'path'
import archiver from 'archiver'

const ZIP_RETRY_DELAY_MS = 30_000

const DEBUG = process.env.DEBUG_WORKER === 'true'

async function writeZipFile(params: {
  outputStoragePath: string
  entries: Array<{ name: string; storagePath: string }>
}) {
  const { outputStoragePath, entries } = params

  const outputPath = getFilePath(outputStoragePath)
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })

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
      const stream = await downloadFile(entry.storagePath)
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
    },
  })

  if (!album) {
    console.warn(`[WORKER] Album not found for ZIP generation: ${albumId}`)
    return
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

  const photos = await prisma.albumPhoto.findMany({
    where: {
      albumId,
      status: 'READY',
    },
    select: {
      id: true,
      fileName: true,
      storagePath: true,
      socialStatus: true,
      socialStoragePath: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  if (photos.length === 0) {
    // Nothing to zip; ensure any old zip is removed.
    const zipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant })
    await fs.promises.unlink(getFilePath(zipStoragePath)).catch(() => {})
    return
  }

  const zipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant })

  if (variant === 'social') {
    const notReady = photos.filter((p) => p.socialStatus !== 'READY' || !p.socialStoragePath)
    if (notReady.length > 0) {
      // Social zips require social derivatives; do nothing for now.
      // Re-schedule so we eventually generate even if no later trigger fires.
      if (DEBUG) {
        console.log(`[WORKER DEBUG] Social ZIP not ready; ${notReady.length} photos missing social derivatives for album ${albumId}`)
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
  }

  const entries = photos.map((p) => {
    const storagePath = variant === 'social' ? (p.socialStoragePath as string) : p.storagePath
    return {
      name: p.fileName,
      storagePath,
    }
  })

  await writeZipFile({
    outputStoragePath: zipStoragePath,
    entries,
  })

  console.log(`[WORKER] Generated ${variant} album ZIP: ${albumId}`)
}
