import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { getFilePath } from '../lib/storage'
import type { AlbumPhotoSocialJob } from '../lib/queue'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '../lib/album-photo-zip'
import fs from 'fs'
import path from 'path'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { syncAlbumZipSizes } from '@/lib/album-zip-size-sync'

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
      storagePath: true,
      status: true,
      socialStoragePath: true,
      socialStatus: true,
      socialFileSize: true,
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

  const socialStoragePath = photo.socialStoragePath || `${photo.storagePath}-social.jpg`

  // If already generated and exists on disk, treat as done.
  try {
    if (photo.socialStatus === 'READY' && socialStoragePath) {
      const existingPath = getFilePath(socialStoragePath)
      if (fs.existsSync(existingPath)) {
        return
      }
    }
  } catch {
    // ignore path validation errors here; we'll handle below during generation
  }

  await prisma.albumPhoto.update({
    where: { id: photoId },
    data: {
      socialStoragePath,
      socialStatus: 'PROCESSING',
      socialError: null,
    },
  })

  // Surface background work at the album level.
  await prisma.album.update({
    where: { id: photo.albumId },
    data: { status: 'PROCESSING' },
  }).catch(() => {})

  try {
    const inputPath = getFilePath(photo.storagePath)
    const outputPath = getFilePath(socialStoragePath)

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })

    const sharpModule = await import('sharp')
    const sharp = sharpModule.default

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
    const newSocialFileSize = BigInt(outStats.size)

    // Update DB first so we have a stored baseline, then adjust Project.totalBytes by the delta.
    const prevSocialFileSize = photo.socialFileSize

    await prisma.albumPhoto.update({
      where: { id: photoId },
      data: {
        socialStoragePath,
        socialStatus: 'READY',
        socialError: null,
        socialGeneratedAt: new Date(),
        socialFileSize: newSocialFileSize,
      },
    })

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
        select: { projectId: true },
      })

      if (album) {
        const zipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: photo.albumId, variant: 'social' })
        await fs.promises.unlink(getFilePath(zipStoragePath)).catch(() => {})

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
    const message = error instanceof Error ? error.message : String(error)

    await prisma.albumPhoto.update({
      where: { id: photoId },
      data: {
        socialStoragePath,
        socialStatus: 'ERROR',
        socialError: message.substring(0, 2000),
      },
    })

    console.error(`[WORKER ERROR] Social derivative failed for ${photoId}:`, error)
    throw error
  }
}
