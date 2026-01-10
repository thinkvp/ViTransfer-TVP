import { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { getFilePath } from '../lib/storage'
import type { AlbumPhotoSocialJob } from '../lib/queue'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '../lib/album-photo-zip'
import fs from 'fs'
import path from 'path'

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

    await prisma.albumPhoto.update({
      where: { id: photoId },
      data: {
        socialStoragePath,
        socialStatus: 'READY',
        socialError: null,
        socialGeneratedAt: new Date(),
      },
    })

    // Invalidate and (debounced) regenerate the social album ZIP.
    try {
      const album = await prisma.album.findUnique({
        where: { id: photo.albumId },
        select: { projectId: true },
      })

      if (album) {
        const zipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: photo.albumId, variant: 'social' })
        await fs.promises.unlink(getFilePath(zipStoragePath)).catch(() => {})

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
