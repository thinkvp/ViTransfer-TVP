import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { downloadFile, getFilePath } from '../lib/storage'
import type { AlbumPhotoZipJob } from '../lib/queue'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '../lib/album-photo-zip'
import fs from 'fs'
import path from 'path'
import archiver from 'archiver'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'

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
      fullZipFileSize: true,
      socialZipFileSize: true,
    },
  })

  if (!album) {
    console.warn(`[WORKER] Album not found for ZIP generation: ${albumId}`)
    return
  }

  const albumRowId = album.id
  const projectId = album.projectId

  // Keep album-level status in sync with background work.
  await prisma.album.update({ where: { id: albumRowId }, data: { status: 'PROCESSING' } }).catch(() => {})

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
      if (pendingSocialCount > 0) return

      const zipFullPath = getFilePath(getAlbumZipStoragePath({ projectId, albumId: albumRowId, variant: 'full' }))
      const zipSocialPath = getFilePath(getAlbumZipStoragePath({ projectId, albumId: albumRowId, variant: 'social' }))

      const fullExists = fs.existsSync(zipFullPath)
      const socialExists = fs.existsSync(zipSocialPath)

      // Consider an empty album READY even if zips do not exist.
      const anyReadyPhotos = await prisma.albumPhoto.count({ where: { albumId, status: 'READY' } })
      if (anyReadyPhotos === 0) {
        await prisma.album.update({ where: { id: albumRowId }, data: { status: 'READY' } })
        return
      }

      if (fullExists && socialExists) {
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

    const prevSize = variant === 'social' ? album.socialZipFileSize : album.fullZipFileSize
    if (prevSize > BigInt(0)) {
      try {
        await prisma.album.update({
          where: { id: album.id },
          data: {
            ...(variant === 'social' ? { socialZipFileSize: BigInt(0) } : { fullZipFileSize: BigInt(0) }),
          },
        })
        await adjustProjectTotalBytes(album.projectId, prevSize * BigInt(-1))
      } catch {
        // Best-effort: daily reconciliation will restore correctness.
      }
    }

    await maybeMarkAlbumReady()
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

  // Persist ZIP size and adjust project totals by the delta.
  try {
    const zipFullPath = getFilePath(zipStoragePath)
    const zipStats = await fs.promises.stat(zipFullPath)
    const newSize = BigInt(zipStats.size)
    const prevSize = variant === 'social' ? album.socialZipFileSize : album.fullZipFileSize

    await prisma.album.update({
      where: { id: album.id },
      data: {
        ...(variant === 'social' ? { socialZipFileSize: newSize } : { fullZipFileSize: newSize }),
      },
    })

    await adjustProjectTotalBytes(album.projectId, newSize - prevSize)
  } catch {
    // Best-effort: if this fails, totals may be stale until daily reconciliation.
  }

  console.log(`[WORKER] Generated ${variant} album ZIP: ${albumId}`)

  await maybeMarkAlbumReady()
}
