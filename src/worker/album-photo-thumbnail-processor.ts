import { Job } from 'bullmq'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream/promises'
import { prisma } from '@/lib/db'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { buildAlbumPhotoThumbnailStoragePath } from '@/lib/project-storage-paths'
import { deleteFile, downloadFile, getFilePath, uploadFile } from '@/lib/storage'
import { isS3Mode, s3FileExists } from '@/lib/s3-storage'
import type { AlbumPhotoThumbnailJob } from '@/lib/queue'

const DEBUG = process.env.DEBUG_WORKER === 'true'

const THUMBNAIL_LONG_EDGE_PX = 320
const THUMBNAIL_JPEG_QUALITY = 82

type AlbumPhotoCandidate = {
  id: string
  albumId: string
  fileName: string
  fileSize: bigint
  storagePath: string
  status: 'UPLOADING' | 'READY' | 'ERROR'
  thumbnailStoragePath: string | null
  thumbnailStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'ERROR'
  thumbnailFileSize: bigint
}

async function thumbnailExists(storagePath: string | null | undefined): Promise<boolean> {
  if (!storagePath) return false
  try {
    return isS3Mode()
      ? await s3FileExists(storagePath)
      : fs.existsSync(getFilePath(storagePath))
  } catch {
    return false
  }
}

async function resolveAlbumCandidates(albumId: string): Promise<AlbumPhotoCandidate[]> {
  const photos = await prisma.albumPhoto.findMany({
    where: { albumId, status: 'READY' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      albumId: true,
      fileName: true,
      fileSize: true,
      storagePath: true,
      status: true,
      thumbnailStoragePath: true,
      thumbnailStatus: true,
      thumbnailFileSize: true,
    },
  })

  const candidates: AlbumPhotoCandidate[] = []
  for (const photo of photos) {
    const thumbnailStoragePath = photo.thumbnailStoragePath || buildAlbumPhotoThumbnailStoragePath(photo.storagePath)
    const alreadyReady = photo.thumbnailStatus === 'READY' && await thumbnailExists(thumbnailStoragePath)
    if (alreadyReady) continue
    candidates.push({ ...photo, thumbnailStoragePath })
  }

  return candidates
}

async function processSinglePhoto(photo: AlbumPhotoCandidate, projectId: string): Promise<{ processedBytes: bigint; error?: string }> {
  const thumbnailStoragePath = photo.thumbnailStoragePath || buildAlbumPhotoThumbnailStoragePath(photo.storagePath)

  await prisma.albumPhoto.update({
    where: { id: photo.id },
    data: {
      thumbnailStoragePath,
      thumbnailStatus: 'PROCESSING',
      thumbnailError: null,
    },
  })

  let tmpInputPath: string | null = null
  let tmpOutputPath: string | null = null

  try {
    const sharpModule = await import('sharp')
    const sharp = sharpModule.default

    let newThumbnailFileSize: bigint

    if (isS3Mode()) {
      const tmpDir = os.tmpdir()
      tmpInputPath = path.join(tmpDir, `album-photo-thumb-input-${photo.id}-${Date.now()}`)
      tmpOutputPath = path.join(tmpDir, `album-photo-thumb-output-${photo.id}-${Date.now()}.jpg`)

      const srcStream = await downloadFile(photo.storagePath)
      await pipeline(srcStream, fs.createWriteStream(tmpInputPath))

      await sharp(tmpInputPath)
        .rotate()
        .resize({
          width: THUMBNAIL_LONG_EDGE_PX,
          height: THUMBNAIL_LONG_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
        .toFile(tmpOutputPath)

      const outStats = await fs.promises.stat(tmpOutputPath)
      newThumbnailFileSize = BigInt(outStats.size)
      await uploadFile(thumbnailStoragePath, fs.createReadStream(tmpOutputPath), outStats.size, 'image/jpeg')
    } else {
      const inputPath = getFilePath(photo.storagePath)
      const outputPath = getFilePath(thumbnailStoragePath)
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })

      await sharp(inputPath)
        .rotate()
        .resize({
          width: THUMBNAIL_LONG_EDGE_PX,
          height: THUMBNAIL_LONG_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
        .toFile(outputPath)

      const outStats = await fs.promises.stat(outputPath)
      newThumbnailFileSize = BigInt(outStats.size)
    }

    await prisma.albumPhoto.update({
      where: { id: photo.id },
      data: {
        thumbnailStoragePath,
        thumbnailStatus: 'READY',
        thumbnailError: null,
        thumbnailGeneratedAt: new Date(),
        thumbnailFileSize: newThumbnailFileSize,
      },
    })

    const delta = newThumbnailFileSize - photo.thumbnailFileSize
    if (delta !== BigInt(0)) {
      await adjustProjectTotalBytes(projectId, delta)
    }

    return { processedBytes: photo.fileSize }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    await prisma.albumPhoto.update({
      where: { id: photo.id },
      data: {
        thumbnailStoragePath,
        thumbnailStatus: 'ERROR',
        thumbnailError: message.substring(0, 2000),
      },
    })

    await deleteFile(thumbnailStoragePath).catch(() => {})

    return { processedBytes: photo.fileSize, error: message }
  } finally {
    if (tmpInputPath) await fs.promises.unlink(tmpInputPath).catch(() => {})
    if (tmpOutputPath) await fs.promises.unlink(tmpOutputPath).catch(() => {})
  }
}

export async function processAlbumPhotoThumbnail(job: Job<AlbumPhotoThumbnailJob>) {
  const { albumThumbnailJobId } = job.data

  if (DEBUG) {
    console.log('[WORKER DEBUG] Album photo thumbnail job data:', JSON.stringify(job.data, null, 2))
  }

  const albumThumbnailJob = await prisma.albumThumbnailJob.findUnique({
    where: { id: albumThumbnailJobId },
  })

  if (!albumThumbnailJob) {
    console.warn(`[WORKER] Album thumbnail job not found: ${albumThumbnailJobId}`)
    return
  }

  const album = await prisma.album.findUnique({
    where: { id: albumThumbnailJob.albumId },
    select: {
      id: true,
      name: true,
      projectId: true,
      project: { select: { title: true } },
    },
  })

  if (!album) {
    await prisma.albumThumbnailJob.update({
      where: { id: albumThumbnailJobId },
      data: {
        status: 'FAILED',
        error: 'Album not found',
        completedAt: new Date(),
      },
    })
    return
  }

  const candidates = await resolveAlbumCandidates(album.id)
  const totalBytes = candidates.reduce((sum, photo) => sum + photo.fileSize, BigInt(0))

  await prisma.albumThumbnailJob.update({
    where: { id: albumThumbnailJobId },
    data: {
      albumName: album.name,
      projectId: album.projectId,
      projectName: album.project.title,
      status: 'IN_PROGRESS',
      error: null,
      totalPhotos: candidates.length,
      processedPhotos: 0,
      totalBytes,
      processedBytes: BigInt(0),
      completedAt: null,
    },
  })

  if (candidates.length === 0) {
    await prisma.albumThumbnailJob.update({
      where: { id: albumThumbnailJobId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    })
    return
  }

  let processedPhotos = 0
  let processedBytes = BigInt(0)
  const failures: string[] = []

  for (const photo of candidates) {
    const result = await processSinglePhoto(photo, album.projectId)
    processedPhotos += 1
    processedBytes += result.processedBytes
    if (result.error) {
      failures.push(`${photo.fileName}: ${result.error}`)
    }

    await prisma.albumThumbnailJob.update({
      where: { id: albumThumbnailJobId },
      data: {
        processedPhotos,
        processedBytes,
      },
    })
  }

  const pendingCount = await prisma.albumPhoto.count({
    where: {
      albumId: album.id,
      status: 'READY',
      OR: [
        { thumbnailStatus: 'PENDING' },
        { thumbnailStoragePath: null },
      ],
    },
  })

  await prisma.albumThumbnailJob.update({
    where: { id: albumThumbnailJobId },
    data: {
      status: failures.length > 0 ? 'FAILED' : 'COMPLETED',
      error: failures.length > 0 ? failures.slice(0, 10).join('\n').substring(0, 2000) : null,
      processedPhotos,
      processedBytes,
      completedAt: new Date(),
    },
  })

  if (pendingCount > 0) {
    await enqueueAlbumThumbnailJob({ albumId: album.id, delayMs: 2_000 }).catch(() => {})
  }
}