import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { getFilePath, downloadFile, uploadFileFromPath, deleteFile } from '../lib/storage'
import type { AlbumPhotoSocialJob } from '../lib/queue'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '../lib/album-photo-zip'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { pipeline } from 'stream/promises'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { syncAlbumZipSizes } from '@/lib/album-zip-size-sync'
import { isS3Mode, s3FileExists } from '@/lib/s3-storage'
import { registerStoredFile, getStoredFilePath } from '@/lib/stored-file'

const DEBUG = process.env.DEBUG_WORKER === 'true'

const SOCIAL_LONG_EDGE_PX = 2048
const SOCIAL_JPEG_QUALITY = 90

export async function processAlbumPhotoSocial(job: Job<AlbumPhotoSocialJob>) {
  const { photoId } = job.data

  if (DEBUG) {
    console.log('[WORKER DEBUG] Album photo social job data:', JSON.stringify(job.data, null, 2))
  }

  const photo = await prisma.albumPhoto.findUnique({
    where: { id: photoId },
    select: {
      id: true,
      albumId: true,
      status: true,
      socialStatus: true,
    },
  })

  if (!photo) {
    console.warn(`[WORKER] Album photo not found: ${photoId}`)
    return
  }

  if (photo.status !== 'READY') {
    if (DEBUG) {
      console.log(`[WORKER DEBUG] Skipping social derivative; photo not READY (${photo.status}): ${photoId}`)
    }
    return
  }

  // Get original photo path and social derivative path from StoredFile
  const origPath = await getStoredFilePath('ALBUM_PHOTO', photoId, 'ORIGINAL')
  if (!origPath) {
    console.warn(`[WORKER] Album photo original path not found: ${photoId}`)
    return
  }
  const socialStoragePath = await getStoredFilePath('ALBUM_PHOTO', photoId, 'SOCIAL') || `${origPath}-social.jpg`

  // Read previous social file size from StoredFile for delta computation
  const prevSocialFile = await prisma.storedFile.findUnique({
    where: { entityType_entityId_fileRole: { entityType: 'ALBUM_PHOTO', entityId: photoId, fileRole: 'SOCIAL' } },
    select: { fileSize: true },
  })
  const prevSocialFileSize = prevSocialFile?.fileSize ?? BigInt(0)

  // If already generated and exists on disk/S3, treat as done.
  try {
    if (photo.socialStatus === 'READY' && socialStoragePath) {
      const exists = isS3Mode()
        ? await s3FileExists(socialStoragePath)
        : fs.existsSync(getFilePath(socialStoragePath))
      if (exists) {
        return
      }
    }
  } catch {
    // ignore path validation errors here; we'll handle below during generation
  }

  await prisma.albumPhoto.update({
    where: { id: photoId },
    data: {
      socialStatus: 'PROCESSING',
      socialError: null,
    },
  })

  // Surface background work at the album level.
  await prisma.album.update({
    where: { id: photo.albumId },
    data: { status: 'PROCESSING' },
  }).catch(() => {})

  let tmpInputPath: string | null = null
  let tmpOutputPath: string | null = null

  try {
    const sharpModule = await import('sharp')
    const sharp = sharpModule.default

    let newSocialFileSize: bigint

    if (isS3Mode()) {
      // In S3 mode, files live in R2 — download to temp, process, upload back.
      const tmpDir = os.tmpdir()
      tmpInputPath = path.join(tmpDir, `photo-input-${photoId}-${Date.now()}`)
      tmpOutputPath = path.join(tmpDir, `photo-social-${photoId}-${Date.now()}.jpg`)

      const srcStream = await downloadFile(origPath)
      await pipeline(srcStream, fs.createWriteStream(tmpInputPath))

      await sharp(tmpInputPath)
        .rotate()
        .resize({
          width: SOCIAL_LONG_EDGE_PX,
          height: SOCIAL_LONG_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: SOCIAL_JPEG_QUALITY })
        .withMetadata()
        .toFile(tmpOutputPath)

      const outStats = await fs.promises.stat(tmpOutputPath)
      newSocialFileSize = BigInt(outStats.size)

      await uploadFileFromPath(socialStoragePath, tmpOutputPath, outStats.size, 'image/jpeg')
    } else {
      const inputPath = getFilePath(origPath)
      const outputPath = getFilePath(socialStoragePath)

      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })

      await sharp(inputPath)
        .rotate()
        .resize({
          width: SOCIAL_LONG_EDGE_PX,
          height: SOCIAL_LONG_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: SOCIAL_JPEG_QUALITY })
        .withMetadata()
        .toFile(outputPath)

      const outStats = await fs.promises.stat(outputPath)
      newSocialFileSize = BigInt(outStats.size)
    }

    // Update DB (legacy path/size columns dropped — StoredFile handles them)
    await prisma.albumPhoto.update({
      where: { id: photoId },
      data: {
        socialStatus: 'READY',
        socialError: null,
        socialGeneratedAt: new Date(),
      },
    })

    // Register in StoredFile registry
    registerStoredFile({
      entityType: 'ALBUM_PHOTO', entityId: photoId, fileRole: 'SOCIAL',
      storagePath: socialStoragePath, fileSize: newSocialFileSize, status: 'READY', generatedAt: new Date(),
    }).catch((err) => console.error(`[WORKER] StoredFile social register failed for photo ${photoId}:`, err))

    // Best-effort: include social derivatives in project totals.
    // If something goes wrong, the daily reconciliation will restore correctness.
    try {
      const album = await prisma.album.findUnique({
        where: { id: photo.albumId },
        select: { projectId: true },
      })

      if (album) {
        await adjustProjectTotalBytes(album.projectId, newSocialFileSize - prevSocialFileSize)
      }
    } catch (e) {
      if (DEBUG) {
        console.warn('[WORKER DEBUG] Failed to adjust project totalBytes for social derivative (continuing):', e)
      }
    }

    // Invalidate and (debounced) regenerate the social album ZIP.
    try {
      const album = await prisma.album.findUnique({
        where: { id: photo.albumId },
        select: {
          projectId: true,
          name: true,
          storageFolderName: true,
          project: {
            select: { title: true,
              companyName: true,
              client: { select: { name: true } },
            },
          },
        },
      })

      if (album) {
        const projectStoragePath = buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
        const zipStoragePath = getAlbumZipStoragePath({
          projectStoragePath,
          albumFolderName: album.storageFolderName || album.name,
          albumName: album.name,
          variant: 'social',
        })
        await deleteFile(zipStoragePath).catch(() => {})

        await syncAlbumZipSizes({ albumId: photo.albumId, projectId: album.projectId }).catch(() => {})

        const { getAlbumPhotoZipQueue } = await import('../lib/queue')
        const q = getAlbumPhotoZipQueue()
        const jobId = getAlbumZipJobId({ albumId: photo.albumId, variant: 'social' })

        await q.remove(jobId).catch(() => {})
        await q.add('generate-album-zip', { albumId: photo.albumId, variant: 'social' }, { jobId, delay: 30_000 }).catch(() => {})
      }
    } catch (e) {
      if (DEBUG) {
        console.warn('[WORKER DEBUG] Failed to schedule social album ZIP regeneration:', e)
      }
    }

    console.log(`[WORKER] Generated social photo derivative: ${photoId}`)
  } catch (error) {
    // Clean up any temp files on error
    if (tmpInputPath) await fs.promises.unlink(tmpInputPath).catch(() => {})
    if (tmpOutputPath) await fs.promises.unlink(tmpOutputPath).catch(() => {})
    tmpInputPath = null
    tmpOutputPath = null
    const message = error instanceof Error ? error.message : String(error)

    await prisma.albumPhoto.update({
      where: { id: photoId },
      data: {
        socialStatus: 'ERROR',
        socialError: message.substring(0, 2000),
      },
    })

    // Enqueue a social ZIP job so the zip processor can re-evaluate album readiness.
    // Without this, the album stays PROCESSING forever when the last derivative errors.
    try {
      const album = await prisma.album.findUnique({
        where: { id: photo.albumId },
        select: { projectId: true },
      })
      if (album) {
        const { getAlbumPhotoZipQueue } = await import('../lib/queue')
        const q = getAlbumPhotoZipQueue()
        const jobId = getAlbumZipJobId({ albumId: photo.albumId, variant: 'social' })
        await q.remove(jobId).catch(() => {})
        await q.add('generate-album-zip', { albumId: photo.albumId, variant: 'social' }, { jobId, delay: 10_000 }).catch(() => {})
      }
    } catch {
      // best-effort
    }

    console.error(`[WORKER ERROR] Social derivative failed for ${photoId}:`, error)
    throw error
  } finally {
    // Always clean up temp files
    if (tmpInputPath) await fs.promises.unlink(tmpInputPath).catch(() => {})
    if (tmpOutputPath) await fs.promises.unlink(tmpOutputPath).catch(() => {})
  }
}
