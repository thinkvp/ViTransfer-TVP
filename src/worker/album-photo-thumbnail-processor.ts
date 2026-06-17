import { Job } from 'bullmq'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream/promises'
import { prisma } from '@/lib/db'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { buildAlbumPhotoThumbnailStoragePath, buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { deleteFile, downloadFile, getFilePath, uploadFile } from '@/lib/storage'
import { isS3Mode, s3FileExists } from '@/lib/s3-storage'
import { registerStoredFile, getStoredFilePath } from '@/lib/stored-file'
import type { AlbumPhotoThumbnailJob } from '@/lib/queue'

const DEBUG = process.env.DEBUG_WORKER === 'true'

const THUMBNAIL_LONG_EDGE_PX = 320
const THUMBNAIL_JPEG_QUALITY = 82

type AlbumPhotoCandidate = {
  id: string
  albumId: string
  fileName: string
  status: 'UPLOADING' | 'READY' | 'ERROR'
  thumbnailStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'ERROR'
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

async function resolveAlbumCandidates(albumId: string, projectStoragePath: string): Promise<AlbumPhotoCandidate[]> {
  const photos = await prisma.albumPhoto.findMany({
    where: { albumId, status: 'READY' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      albumId: true,
      fileName: true,
      status: true,
      thumbnailStatus: true,
    },
  })

  const candidates: AlbumPhotoCandidate[] = []
  for (const photo of photos) {
    // Get the original photo path from StoredFile
    const origPath = await getStoredFilePath('ALBUM_PHOTO', photo.id, 'ORIGINAL')
    const thumbnailStoragePath = origPath
      ? buildAlbumPhotoThumbnailStoragePath(projectStoragePath, origPath)
      : null
    if (!thumbnailStoragePath) continue
    const alreadyReady = photo.thumbnailStatus === 'READY' && await thumbnailExists(thumbnailStoragePath)
    if (alreadyReady) continue
    candidates.push({ ...photo, thumbnailStoragePath } as AlbumPhotoCandidate)
  }

  return candidates
}

async function rescheduleAlbumThumbnailJob(params: {
  albumThumbnailJobId: string
  albumId: string
  delayMs: number
}) {
  const { albumThumbnailJobId, albumId, delayMs } = params

  await prisma.albumThumbnailJob.update({
    where: { id: albumThumbnailJobId },
    data: {
      status: 'PENDING',
      error: null,
      completedAt: null,
    },
  })

  await enqueueAlbumThumbnailJob({ albumId, delayMs })
}

async function processSinglePhoto(photo: AlbumPhotoCandidate, projectId: string, projectStoragePath: string): Promise<{ processedBytes: bigint; error?: string }> {
  // Get original path from StoredFile
  const origPath = await getStoredFilePath('ALBUM_PHOTO', photo.id, 'ORIGINAL')
  if (!origPath) return { processedBytes: BigInt(0), error: 'Original file path not found' }
  const thumbnailStoragePath = buildAlbumPhotoThumbnailStoragePath(projectStoragePath, origPath)

  // Read previous thumbnail size from StoredFile for delta computation
  const prevThumbFile = await prisma.storedFile.findUnique({
    where: { entityType_entityId_fileRole: { entityType: 'ALBUM_PHOTO', entityId: photo.id, fileRole: 'THUMBNAIL' } },
    select: { fileSize: true },
  })
  const prevThumbFileSize = prevThumbFile?.fileSize ?? BigInt(0)

  await prisma.albumPhoto.update({
    where: { id: photo.id },
    data: {
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

      const srcStream = await downloadFile(origPath)
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
      const inputPath = getFilePath(origPath)
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

    // Register in StoredFile registry BEFORE marking the photo as READY,
    // so a transient DB failure doesn't leave the file on S3 with no
    // StoredFile record (which would cause the storage integrity scan to
    // falsely report it as "missing").
    await registerStoredFile({
      entityType: 'ALBUM_PHOTO', entityId: photo.id, fileRole: 'THUMBNAIL',
      storagePath: thumbnailStoragePath, fileSize: newThumbnailFileSize, status: 'READY', generatedAt: new Date(),
    })

    await prisma.albumPhoto.update({
      where: { id: photo.id },
      data: {
        thumbnailStatus: 'READY',
        thumbnailError: null,
        thumbnailGeneratedAt: new Date(),
      },
    })

    const delta = newThumbnailFileSize - prevThumbFileSize
    if (delta !== BigInt(0)) {
      await adjustProjectTotalBytes(projectId, delta)
    }

    // Read original file size from StoredFile
    const origFile = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'ALBUM_PHOTO', entityId: photo.id, fileRole: 'ORIGINAL' } },
      select: { fileSize: true },
    })
    return { processedBytes: origFile?.fileSize ?? BigInt(0) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    await prisma.albumPhoto.update({
      where: { id: photo.id },
      data: {
        thumbnailStatus: 'ERROR',
        thumbnailError: message.substring(0, 2000),
      },
    })

    await deleteFile(thumbnailStoragePath).catch(() => {})

    // Get file size from StoredFile
    const origStored = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'ALBUM_PHOTO', entityId: photo.id, fileRole: 'ORIGINAL' } },
      select: { fileSize: true },
    })
    return { processedBytes: origStored?.fileSize ?? BigInt(0), error: message }
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
      project: { select: { title: true, companyName: true, storagePath: true, client: { select: { name: true } } } },
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

  const projectStoragePath = album.project.storagePath || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
  const candidates = await resolveAlbumCandidates(album.id, projectStoragePath)
  const totalBytes = BigInt(0) // Computed from StoredFile as needed

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

  const uploadingCountAtStart = await prisma.albumPhoto.count({
    where: { albumId: album.id, status: 'UPLOADING' },
  })

  if (candidates.length === 0) {
    if (uploadingCountAtStart > 0) {
      await rescheduleAlbumThumbnailJob({
        albumThumbnailJobId,
        albumId: album.id,
        delayMs: 2_000,
      })
      return
    }

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
    const result = await processSinglePhoto(photo, album.projectId, projectStoragePath)
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

  const [uploadingCount, pendingCount] = await Promise.all([
    prisma.albumPhoto.count({
      where: { albumId: album.id, status: 'UPLOADING' },
    }),
    prisma.albumPhoto.count({
      where: {
        albumId: album.id,
        status: 'READY',
        OR: [
          { thumbnailStatus: 'PENDING' },
        ],
      },
    }),
  ])

  if (uploadingCount > 0 || pendingCount > 0) {
    await rescheduleAlbumThumbnailJob({
      albumThumbnailJobId,
      albumId: album.id,
      delayMs: 2_000,
    })
    return
  }

  await prisma.albumThumbnailJob.update({
    where: {
      id: albumThumbnailJobId,
    },
    data: {
      status: failures.length > 0 ? 'FAILED' : 'COMPLETED',
      error: failures.length > 0 ? failures.slice(0, 10).join('\n').substring(0, 2000) : null,
      processedPhotos,
      processedBytes,
      completedAt: new Date(),
    },
  })
}