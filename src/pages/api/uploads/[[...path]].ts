import { Server } from '@tus/server'
import { FileStore } from '@tus/file-store'
import { prisma } from '@/lib/db'
import { videoQueue } from '@/lib/queue'
import { ALL_ALLOWED_EXTENSIONS } from '@/lib/asset-validation'
import { isDropboxStoragePath, stripDropboxStoragePrefix } from '@/lib/storage-provider-dropbox'
import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import type { NextApiRequest, NextApiResponse } from 'next'

// Store TUS temp files inside STORAGE_ROOT so that the final "copy" to the
// destination path is an atomic fs.rename (zero cost) rather than a full
// re-read and re-write of potentially gigabytes of data.
const _STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')
const TUS_UPLOAD_DIR = path.join(_STORAGE_ROOT, '.tus-tmp')

const BYTES_PER_GB = 1024 * 1024 * 1024
const DEFAULT_MAX_UPLOAD_SIZE_GB = 1
const HARD_MAX_UPLOAD_SIZE_GB = 50
const MAX_UPLOAD_SIZE_CACHE_TTL_MS = 60_000

const cachedMaxUploadSizeBytes: { value: number; expiresAt: number } = {
  value: DEFAULT_MAX_UPLOAD_SIZE_GB * BYTES_PER_GB,
  expiresAt: 0,
}

async function getMaxUploadSizeBytes(): Promise<number> {
  const now = Date.now()
  if (cachedMaxUploadSizeBytes.expiresAt > now) {
    return cachedMaxUploadSizeBytes.value
  }

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { maxUploadSizeGB: true },
    })

    const gb = Math.max(
      1,
      Math.min(HARD_MAX_UPLOAD_SIZE_GB, settings?.maxUploadSizeGB ?? DEFAULT_MAX_UPLOAD_SIZE_GB)
    )

    cachedMaxUploadSizeBytes.value = gb * BYTES_PER_GB
    cachedMaxUploadSizeBytes.expiresAt = now + MAX_UPLOAD_SIZE_CACHE_TTL_MS
    return cachedMaxUploadSizeBytes.value
  } catch (err) {
    // Fail closed-ish: keep a conservative default, but do not block uploads due to transient DB issues.
    cachedMaxUploadSizeBytes.value = DEFAULT_MAX_UPLOAD_SIZE_GB * BYTES_PER_GB
    cachedMaxUploadSizeBytes.expiresAt = now + MAX_UPLOAD_SIZE_CACHE_TTL_MS
    return cachedMaxUploadSizeBytes.value
  }
}

if (!fs.existsSync(TUS_UPLOAD_DIR)) {
  fs.mkdirSync(TUS_UPLOAD_DIR, { recursive: true })
}

const tusServer: Server = new Server({
  path: '/api/uploads',
  datastore: new FileStore({
    directory: TUS_UPLOAD_DIR,
  }),

  // Hard upper bound to prevent unlimited disk usage even if DB/config is mis-set.
  maxSize: HARD_MAX_UPLOAD_SIZE_GB * BYTES_PER_GB,
  respectForwardedHeaders: true,
  relativeLocation: true,

  async onUploadCreate(req, upload) {
    try {
      const { parseBearerToken, verifyAdminAccessToken } = await import('@/lib/auth')
      const bearer = parseBearerToken(req as any)

      if (!bearer) {
        throw {
          status_code: 401,
          body: 'Authentication required'
        }
      }

      const payload = await verifyAdminAccessToken(bearer)

      if (!payload) {
        throw {
          status_code: 403,
          body: 'Access required'
        }
      }

      const videoId = upload.metadata?.videoId as string
      const assetId = upload.metadata?.assetId as string
      const clientFileId = upload.metadata?.clientFileId as string
      const userFileId = upload.metadata?.userFileId as string
      const projectFileId = upload.metadata?.projectFileId as string
      const projectEmailId = upload.metadata?.projectEmailId as string
      const photoId = upload.metadata?.photoId as string

      // `maxUploadSizeGB` is a conservative limit meant for general-purpose uploads.
      // Do not apply it to video/version uploads (which can legitimately be multi-GB).
      // Those are still bounded by the server hard cap (`maxSize`).
      const isVideoOrAssetUpload = !!videoId || !!assetId

      const declaredSize = Number(upload.size)
      if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
        throw {
          status_code: 400,
          body: 'Upload size required'
        }
      }

      if (!isVideoOrAssetUpload) {
        const maxUploadSizeBytes = await getMaxUploadSizeBytes()
        if (declaredSize > maxUploadSizeBytes) {
          throw {
            status_code: 413,
            body: `Upload exceeds max allowed size of ${Math.ceil(maxUploadSizeBytes / BYTES_PER_GB)}GB`
          }
        }
      }

      if (!videoId && !assetId && !clientFileId && !userFileId && !projectFileId && !projectEmailId && !photoId) {
        throw {
          status_code: 400,
          body: 'Missing required metadata: videoId, assetId, clientFileId, userFileId, projectFileId, projectEmailId, or photoId'
        }
      }

      if (videoId) {
        const video = await prisma.video.findUnique({
          where: { id: videoId }
        })

        if (!video) {
          throw {
            status_code: 404,
            body: 'Video record not found'
          }
        }

        if (video.status === 'ERROR') {
          // Allow re-uploading to a video that previously failed — reset it.
          await prisma.video.update({
            where: { id: videoId },
            data: { status: 'UPLOADING', processingError: null, processingProgress: 0 },
          })
        } else if (video.status !== 'UPLOADING') {
          throw {
            status_code: 400,
            body: 'Video is not in UPLOADING state'
          }
        }
      }

      if (assetId) {
        const asset = await prisma.videoAsset.findUnique({
          where: { id: assetId }
        })

        if (!asset) {
          throw {
            status_code: 404,
            body: 'Asset record not found'
          }
        }
      }

      if (clientFileId) {
        const file = await prisma.clientFile.findUnique({
          where: { id: clientFileId }
        })

        if (!file) {
          throw {
            status_code: 404,
            body: 'Client file record not found'
          }
        }
      }

      if (userFileId) {
        const file = await prisma.userFile.findUnique({
          where: { id: userFileId }
        })

        if (!file) {
          throw {
            status_code: 404,
            body: 'User file record not found'
          }
        }
      }

      if (projectFileId) {
        const file = await prisma.projectFile.findUnique({
          where: { id: projectFileId }
        })

        if (!file) {
          throw {
            status_code: 404,
            body: 'Project file record not found'
          }
        }
      }

      if (projectEmailId) {
        const email = await prisma.projectEmail.findUnique({
          where: { id: projectEmailId }
        })

        if (!email) {
          throw {
            status_code: 404,
            body: 'Project email record not found'
          }
        }
      }

      if (photoId) {
        const photo = await prisma.albumPhoto.findUnique({
          where: { id: photoId }
        })

        if (!photo) {
          throw {
            status_code: 404,
            body: 'Photo record not found'
          }
        }

        if (photo.status !== 'UPLOADING') {
          throw {
            status_code: 400,
            body: 'Photo is not in UPLOADING state'
          }
        }
      }

      return { metadata: upload.metadata }
    } catch (error) {
      console.error('[UPLOAD] Error in onUploadCreate:', error)
      throw error
    }
  },

  async onUploadFinish(req, upload) {
    const tusFilePath = path.join(TUS_UPLOAD_DIR, upload.id)
    const videoId = upload.metadata?.videoId as string
    const assetId = upload.metadata?.assetId as string
    const clientFileId = upload.metadata?.clientFileId as string
    const userFileId = upload.metadata?.userFileId as string
    const projectFileId = upload.metadata?.projectFileId as string
    const projectEmailId = upload.metadata?.projectEmailId as string
    const photoId = upload.metadata?.photoId as string

    try {
      const maxUploadSizeBytes = await getMaxUploadSizeBytes()
      // Video/asset uploads are only bounded by the hard cap (same as onUploadCreate).
      const hardMaxBytes = HARD_MAX_UPLOAD_SIZE_GB * BYTES_PER_GB
      if (videoId) {
        return await handleVideoUploadFinish(tusFilePath, upload, videoId, tusServer, hardMaxBytes)
      } else if (assetId) {
        return await handleAssetUploadFinish(tusFilePath, upload, assetId, tusServer, hardMaxBytes)
      } else if (clientFileId) {
        return await handleClientFileUploadFinish(tusFilePath, upload, clientFileId, tusServer, maxUploadSizeBytes)
      } else if (userFileId) {
        return await handleUserFileUploadFinish(tusFilePath, upload, userFileId, tusServer, maxUploadSizeBytes)
      } else if (projectFileId) {
        return await handleProjectFileUploadFinish(tusFilePath, upload, projectFileId, tusServer, maxUploadSizeBytes)
      } else if (projectEmailId) {
        return await handleProjectEmailUploadFinish(tusFilePath, upload, projectEmailId, tusServer, maxUploadSizeBytes)
      } else if (photoId) {
        return await handleAlbumPhotoUploadFinish(tusFilePath, upload, photoId, tusServer, maxUploadSizeBytes)
      } else {
        console.error('[UPLOAD] No videoId or assetId in upload metadata')
        return {}
      }
    } catch (error) {
      console.error('[UPLOAD] Error in onUploadFinish:', error)
      await cleanupTUSFile(tusFilePath)

      if (videoId) {
        await markVideoAsError(videoId, error)
      }

      if (projectEmailId) {
        await markProjectEmailAsError(projectEmailId, error)
      }

      if (photoId) {
        await markPhotoAsError(photoId, error)
      }

      throw error
    }
  }
})

async function handleVideoUploadFinish(
  tusFilePath: string,
  upload: any,
  videoId: string,
  tusServer: any,
  maxUploadSizeBytes: number
) {
  const video = await prisma.video.findUnique({
    where: { id: videoId }
  })

  if (!video) {
    console.error(`[UPLOAD] Video not found: ${videoId}`)
    await cleanupTUSFile(tusFilePath)
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size, maxUploadSizeBytes)

  await validateVideoFile(tusFilePath, upload.metadata?.filename as string)

  const { moveUploadedFile } = await import('@/lib/storage')
  await moveUploadedFile(tusFilePath, video.originalStoragePath, fileSize)

  // Update video status to QUEUED — upload is complete and the job is waiting in the worker queue.
  // The worker will advance this to PROCESSING when it actually begins work.
  const isDropbox = isDropboxStoragePath(video.originalStoragePath)
  await prisma.video.update({
    where: { id: videoId },
    data: {
      status: 'QUEUED',
      processingProgress: 0,
      ...(isDropbox ? { dropboxUploadStatus: 'PENDING' } : {}),
    },
  })

  console.log(`[UPLOAD] Video ${videoId} upload complete, status updated to QUEUED`)

  await videoQueue.add('process-video', {
    videoId: video.id,
    originalStoragePath: video.originalStoragePath,
    projectId: video.projectId,
  })

  console.log(`[UPLOAD] Video ${videoId} queued for worker processing`)

  // Enqueue background Dropbox upload (runs in parallel with video processing)
  if (isDropbox) {
    const localPath = stripDropboxStoragePrefix(video.originalStoragePath)
    const { getDropboxUploadQueue } = await import('@/lib/queue')
    const dropboxQueue = getDropboxUploadQueue()
    await dropboxQueue.add('upload-to-dropbox', {
      videoId: video.id,
      localPath,
      dropboxPath: video.originalStoragePath,
      dropboxRelPath: video.dropboxPath,
      fileSizeBytes: fileSize,
    })
    console.log(`[UPLOAD] Video ${videoId} queued for Dropbox upload`)
  }

  return {}
}

async function handleAssetUploadFinish(
  tusFilePath: string,
  upload: any,
  assetId: string,
  tusServer: any,
  maxUploadSizeBytes: number
) {
  const asset = await prisma.videoAsset.findUnique({
    where: { id: assetId }
  })

  if (!asset) {
    console.error(`[UPLOAD] Asset not found: ${assetId}`)
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size, maxUploadSizeBytes)

  await validateAssetFile(tusFilePath, upload.metadata?.filename as string)

  const { moveUploadedFile } = await import('@/lib/storage')
  await moveUploadedFile(tusFilePath, asset.storagePath, fileSize)

  // Do not trust client-supplied MIME from upload metadata; worker will set verified type after magic-byte validation
  const actualFileType = 'application/octet-stream'

  await prisma.videoAsset.update({
    where: { id: assetId },
    data: {
      fileType: actualFileType,
    },
  })

  // Queue asset for magic byte validation in worker
  const { getAssetQueue } = await import('@/lib/queue')
  const assetQueue = getAssetQueue()

  await assetQueue.add('process-asset', {
    assetId: asset.id,
    storagePath: asset.storagePath,
    expectedCategory: asset.category ?? undefined,
  })

  // Enqueue background Dropbox upload for asset (runs after/concurrent with validation)
  if (isDropboxStoragePath(asset.storagePath)) {
    const { getDropboxUploadQueue } = await import('@/lib/queue')
    const { stripDropboxStoragePrefix } = await import('@/lib/storage-provider-dropbox')
    const dropboxQueue = getDropboxUploadQueue()
    await dropboxQueue.add('upload-asset-to-dropbox', {
      videoId: asset.videoId,
      localPath: stripDropboxStoragePrefix(asset.storagePath),
      dropboxPath: asset.storagePath,
      dropboxRelPath: asset.dropboxPath,
      fileSizeBytes: fileSize,
      assetId: asset.id,
    })
    console.log(`[UPLOAD] Asset ${assetId} queued for Dropbox upload`)
  }

  console.log(`[UPLOAD] Asset uploaded and queued for processing: ${assetId}`)

  return {}
}

async function handleClientFileUploadFinish(
  tusFilePath: string,
  upload: any,
  clientFileId: string,
  tusServer: any,
  maxUploadSizeBytes: number
) {
  const clientFile = await prisma.clientFile.findUnique({
    where: { id: clientFileId }
  })

  if (!clientFile) {
    console.error(`[UPLOAD] Client file not found: ${clientFileId}`)
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size, maxUploadSizeBytes)

  await validateAssetFile(tusFilePath, upload.metadata?.filename as string)

  const { moveUploadedFile } = await import('@/lib/storage')
  await moveUploadedFile(tusFilePath, clientFile.storagePath, fileSize)

  // Do not trust client-supplied MIME; worker will set verified type after magic-byte validation
  const actualFileType = 'application/octet-stream'

  await prisma.clientFile.update({
    where: { id: clientFileId },
    data: {
      fileType: actualFileType,
    },
  })

  // Queue client file for magic byte validation
  const { getClientFileQueue } = await import('@/lib/queue')
  const q = getClientFileQueue()
  await q.add('process-client-file', {
    clientFileId: clientFile.id,
    storagePath: clientFile.storagePath,
    expectedCategory: clientFile.category ?? undefined,
  })

  console.log(`[UPLOAD] Client file uploaded and queued for processing: ${clientFileId}`)

  return {}
}

async function handleUserFileUploadFinish(
  tusFilePath: string,
  upload: any,
  userFileId: string,
  tusServer: any,
  maxUploadSizeBytes: number
) {
  const userFile = await prisma.userFile.findUnique({
    where: { id: userFileId }
  })

  if (!userFile) {
    console.error(`[UPLOAD] User file not found: ${userFileId}`)
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size, maxUploadSizeBytes)

  await validateAssetFile(tusFilePath, upload.metadata?.filename as string)

  const { moveUploadedFile } = await import('@/lib/storage')
  await moveUploadedFile(tusFilePath, userFile.storagePath, fileSize)

  const actualFileType = 'application/octet-stream'

  await prisma.userFile.update({
    where: { id: userFileId },
    data: {
      fileType: actualFileType,
    },
  })

  const { getUserFileQueue } = await import('@/lib/queue')
  const q = getUserFileQueue()
  await q.add('process-user-file', {
    userFileId: userFile.id,
    storagePath: userFile.storagePath,
    expectedCategory: userFile.category ?? undefined,
  })

  console.log(`[UPLOAD] User file uploaded and queued for processing: ${userFileId}`)

  return {}
}

async function handleProjectFileUploadFinish(
  tusFilePath: string,
  upload: any,
  projectFileId: string,
  tusServer: any,
  maxUploadSizeBytes: number
) {
  const projectFile = await prisma.projectFile.findUnique({
    where: { id: projectFileId }
  })

  if (!projectFile) {
    console.error(`[UPLOAD] Project file not found: ${projectFileId}`)
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size, maxUploadSizeBytes)

  await validateAssetFile(tusFilePath, upload.metadata?.filename as string)

  const { moveUploadedFile } = await import('@/lib/storage')
  await moveUploadedFile(tusFilePath, projectFile.storagePath, fileSize)

  // Do not trust client-supplied MIME; worker will set verified type after magic-byte validation
  const actualFileType = 'application/octet-stream'

  await prisma.projectFile.update({
    where: { id: projectFileId },
    data: {
      fileType: actualFileType,
    },
  })

  // Queue project file for magic byte validation
  const { getProjectFileQueue } = await import('@/lib/queue')
  const q = getProjectFileQueue()
  await q.add('process-project-file', {
    projectFileId: projectFile.id,
    storagePath: projectFile.storagePath,
    expectedCategory: projectFile.category ?? undefined,
  })

  console.log(`[UPLOAD] Project file uploaded and queued for processing: ${projectFileId}`)

  return {}
}

async function handleProjectEmailUploadFinish(
  tusFilePath: string,
  upload: any,
  projectEmailId: string,
  tusServer: any,
  maxUploadSizeBytes: number
) {
  const email = await prisma.projectEmail.findUnique({
    where: { id: projectEmailId }
  })

  if (!email) {
    console.error(`[UPLOAD] Project email not found: ${projectEmailId}`)
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size, maxUploadSizeBytes)

  await validateEmlFile(tusFilePath, upload.metadata?.filename as string)

  const { moveUploadedFile } = await import('@/lib/storage')
  await moveUploadedFile(tusFilePath, email.rawStoragePath, fileSize)

  const actualFileType = 'message/rfc822'

  await prisma.projectEmail.update({
    where: { id: projectEmailId },
    data: {
      rawFileType: actualFileType,
      status: 'PROCESSING',
      errorMessage: null,
    },
  })

  // Queue email parsing + attachment extraction
  const { getProjectEmailQueue } = await import('@/lib/queue')
  const q = getProjectEmailQueue()
  await q.add('process-project-email', {
    projectEmailId: email.id,
    projectId: email.projectId,
    rawStoragePath: email.rawStoragePath,
  })

  console.log(`[UPLOAD] Project email uploaded and queued for processing: ${projectEmailId}`)

  return {}
}

async function handleAlbumPhotoUploadFinish(
  tusFilePath: string,
  upload: any,
  photoId: string,
  tusServer: any,
  maxUploadSizeBytes: number
) {
  const photo = await prisma.albumPhoto.findUnique({
    where: { id: photoId },
    include: { album: true },
  })

  if (!photo) {
    console.error(`[UPLOAD] Album photo not found: ${photoId}`)
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size, maxUploadSizeBytes)

  await validateAlbumPhotoFile(tusFilePath, upload.metadata?.filename as string)

  const { moveUploadedFile } = await import('@/lib/storage')
  await moveUploadedFile(tusFilePath, photo.storagePath, fileSize)

  const actualFileType = 'image/jpeg'

  const socialStoragePath = photo.socialStoragePath || `${photo.storagePath}-social.jpg`

  await prisma.albumPhoto.update({
    where: { id: photoId },
    data: {
      fileType: actualFileType,
      status: 'READY',
      error: null,
      socialStoragePath,
      socialStatus: 'PENDING',
      socialError: null,
    },
  })

  // Upload is complete; downstream derivative + ZIP work will run next.
  await prisma.album.update({
    where: { id: photo.albumId },
    data: { status: 'PROCESSING' },
  }).catch(() => {})

  await cleanupTUSFile(tusFilePath).catch(() => {}) // no-op if already moved; cleans up any orphaned sidecar

  console.log(`[UPLOAD] Album photo uploaded and marked READY: ${photoId}`)

  // Queue social-size derivative generation
  try {
    const { getAlbumPhotoSocialQueue } = await import('@/lib/queue')
    const q = getAlbumPhotoSocialQueue()
    await q.add(
      'process-album-photo-social',
      { photoId },
      {
        jobId: `album-photo-social-${photoId}`,
      }
    )
  } catch (e) {
    // Best-effort: social generation can be triggered later (e.g. on download).
    console.warn('[UPLOAD] Failed to enqueue album photo social derivative job:', e)
  }

  // Invalidate and (debounced) regenerate album ZIPs
  try {
    const { deleteFile } = await import('@/lib/storage')
    const { getAlbumZipJobId, getAlbumZipStoragePath } = await import('@/lib/album-photo-zip')
    const { syncAlbumZipSizes } = await import('@/lib/album-zip-size-sync')
    const { getAlbumPhotoZipQueue } = await import('@/lib/queue')

    const fullZipPath = getAlbumZipStoragePath({
      projectId: photo.album.projectId,
      albumId: photo.albumId,
      albumName: photo.album.name,
      variant: 'full',
    })
    const socialZipPath = getAlbumZipStoragePath({
      projectId: photo.album.projectId,
      albumId: photo.albumId,
      albumName: photo.album.name,
      variant: 'social',
    })

    await deleteFile(fullZipPath).catch(() => {})
    await deleteFile(socialZipPath).catch(() => {})

    // Delete old Dropbox copies and reset tracking so re-upload queues after new ZIPs are ready
    if (photo.album.dropboxEnabled) {
      const { isDropboxStorageConfigured, deleteDropboxFile } = await import('@/lib/storage-provider-dropbox')
      const dbxPaths = [
        photo.album.fullZipDropboxPath,
        photo.album.socialZipDropboxPath,
      ].filter(Boolean) as string[]
      if (isDropboxStorageConfigured()) {
        await Promise.allSettled(dbxPaths.map((p) => deleteDropboxFile('', p).catch(() => {})))
      }
      await prisma.album.update({
        where: { id: photo.albumId },
        data: {
          fullZipDropboxStatus: null,
          fullZipDropboxProgress: 0,
          fullZipDropboxError: null,
          fullZipDropboxPath: null,
          socialZipDropboxStatus: null,
          socialZipDropboxProgress: 0,
          socialZipDropboxError: null,
          socialZipDropboxPath: null,
        },
      }).catch(() => {})
    }

    await syncAlbumZipSizes({ albumId: photo.albumId, projectId: photo.album.projectId }).catch(() => {})

    const zipQueue = getAlbumPhotoZipQueue()

    const fullJobId = getAlbumZipJobId({ albumId: photo.albumId, variant: 'full' })
    const socialJobId = getAlbumZipJobId({ albumId: photo.albumId, variant: 'social' })

    await zipQueue.remove(fullJobId).catch(() => {})
    await zipQueue.remove(socialJobId).catch(() => {})

    // Delay to allow large batches to finish; the worker also skips if uploads are still in progress.
    const delayMs = 30_000
    await zipQueue.add('generate-album-zip', { albumId: photo.albumId, variant: 'full' }, { jobId: fullJobId, delay: delayMs })
    await zipQueue.add('generate-album-zip', { albumId: photo.albumId, variant: 'social' }, { jobId: socialJobId, delay: delayMs })
  } catch (e) {
    console.warn('[UPLOAD] Failed to schedule album ZIP regeneration:', e)
  }

  await cleanupTUSFile(tusFilePath)
  return {}
}

async function verifyUploadedFile(
  tusFilePath: string,
  expectedSize: unknown,
  maxUploadSizeBytes: number
): Promise<number> {
  if (!fs.existsSync(tusFilePath)) {
    throw new Error('Uploaded file not found on disk')
  }

  const fileStats = fs.statSync(tusFilePath)
  const fileSize = fileStats.size

  const expected = typeof expectedSize === 'number' ? expectedSize : Number(expectedSize)
  if (Number.isFinite(expected) && expected > 0 && fileSize !== expected) {
    await cleanupTUSFile(tusFilePath)
    throw new Error(
      `File size mismatch: expected ${expectedSize} bytes, got ${fileSize} bytes. ` +
      `Upload may have been interrupted.`
    )
  }

  if (fileSize > maxUploadSizeBytes) {
    await cleanupTUSFile(tusFilePath)
    throw new Error(
      `File too large: ${fileSize} bytes exceeds configured max of ${maxUploadSizeBytes} bytes.`
    )
  }

  return fileSize
}

async function validateVideoFile(tusFilePath: string, filename?: string) {
  // Validate file extension
  if (filename) {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
    const allowedExtensions = ['.mp4', '.mov', '.avi', '.webm', '.mkv']

    if (!allowedExtensions.includes(ext)) {
      await cleanupTUSFile(tusFilePath)
      throw new Error(
        `Invalid file extension: ${ext}. Allowed video formats: ${allowedExtensions.join(', ')}`
      )
    }
  }

  // NOTE: Magic byte validation is performed in the video-processor worker
  // This ensures proper file content validation happens during processing
  // without causing Next.js build issues with the file-type ESM module
  console.log(`[UPLOAD] File extension validation passed, magic byte check will run in worker`)
}

async function validateAssetFile(tusFilePath: string, filename?: string) {
  // Validate file extension
  if (filename) {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
    if (!ALL_ALLOWED_EXTENSIONS.includes(ext)) {
      await cleanupTUSFile(tusFilePath)
      throw new Error(
        `Invalid file extension: ${ext}. Allowed: ${ALL_ALLOWED_EXTENSIONS.join(', ')}`
      )
    }
  }

  // NOTE: Magic byte validation is performed in the asset-processor worker
  // This ensures proper file content validation happens during processing
  // without causing Next.js build issues with the file-type ESM module
  console.log(`[UPLOAD] Asset extension validation passed, magic byte check will run in worker`)
}

async function validateAlbumPhotoFile(tusFilePath: string, filename?: string) {
  if (filename) {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
    const allowedExtensions = ['.jpg', '.jpeg']
    if (!allowedExtensions.includes(ext)) {
      await cleanupTUSFile(tusFilePath)
      throw new Error(
        `Invalid file extension: ${ext}. Allowed: ${allowedExtensions.join(', ')}`
      )
    }
  }

  console.log(`[UPLOAD] Album photo extension validation passed`)
}

async function validateEmlFile(tusFilePath: string, filename?: string) {
  if (filename) {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
    if (ext !== '.eml') {
      await cleanupTUSFile(tusFilePath)
      throw new Error('Invalid file extension. Only .eml files are supported')
    }
  }
}

async function cleanupTUSFile(tusFilePath: string) {
  try {
    if (fs.existsSync(tusFilePath)) {
      fs.unlinkSync(tusFilePath)
    }
    const metadataPath = `${tusFilePath}.json`
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath)
    }
  } catch (cleanupErr) {
    console.error('[UPLOAD] Failed to cleanup TUS files:', cleanupErr)
  }
}

async function markVideoAsError(videoId: string, error: any) {
  try {
    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: 'ERROR',
        processingError: error instanceof Error ? error.message : 'Unknown upload error'
      }
    })
  } catch (dbError) {
    console.error('[UPLOAD] Failed to mark video as ERROR:', dbError)
  }
}

async function markPhotoAsError(photoId: string, error: any) {
  try {
    await prisma.albumPhoto.update({
      where: { id: photoId },
      data: {
        status: 'ERROR',
        error: error instanceof Error ? error.message : 'Unknown upload error',
      },
    })
  } catch (dbError) {
    console.error('[UPLOAD] Failed to mark album photo as ERROR:', dbError)
  }
}

async function markProjectEmailAsError(projectEmailId: string, error: any) {
  try {
    await prisma.projectEmail.update({
      where: { id: projectEmailId },
      data: {
        status: 'ERROR',
        errorMessage: error instanceof Error ? error.message : 'Unknown upload error',
      },
    })
  } catch (dbError) {
    console.error('[UPLOAD] Failed to mark project email as ERROR:', dbError)
  }
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
  maxDuration: 3600,
}

function sanitizeForwardedHeaders(req: NextApiRequest) {
  const rawProto = req.headers['x-forwarded-proto']
  const protoValue = (Array.isArray(rawProto) ? rawProto[0] : rawProto)?.split(',')[0]?.trim().toLowerCase()
  req.headers['x-forwarded-proto'] = protoValue === 'https' ? 'https' : 'http'

  const rawHost = req.headers['x-forwarded-host'] || req.headers.host
  const hostValue = (Array.isArray(rawHost) ? rawHost[0] : rawHost)?.split(',')[0]?.trim()
  const safeHost = hostValue && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(hostValue) ? hostValue : 'localhost'

  req.headers.host = safeHost
  req.headers['x-forwarded-host'] = safeHost
}

function toWebRequest(req: NextApiRequest): Request {
  const rawProto = req.headers['x-forwarded-proto']
  const protoValue = (Array.isArray(rawProto) ? rawProto[0] : rawProto)?.split(',')[0]?.trim().toLowerCase()
  const protocol = protoValue === 'https' ? 'https' : 'http'

  const rawHost = req.headers['x-forwarded-host'] || req.headers.host
  const hostValue = (Array.isArray(rawHost) ? rawHost[0] : rawHost)?.split(',')[0]?.trim()
  const safeHost = hostValue && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(hostValue) ? hostValue : 'localhost'

  const url = `${protocol}://${safeHost}${req.url || '/'}`

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) continue
    headers.set(key, Array.isArray(value) ? value[0] : value)
  }

  let body: ReadableStream | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // @ts-ignore Node 18+ bridge available in runtime
    body = Readable.toWeb(req)
  }

  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body,
    // @ts-ignore Required for streamed request bodies in Node fetch
    duplex: 'half',
  })
}

async function fromWebResponse(webRes: Response, res: NextApiResponse): Promise<void> {
  res.status(webRes.status)

  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  if (webRes.body) {
    const reader = webRes.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  if (!res.writableEnded) {
    res.end()
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    sanitizeForwardedHeaders(req)
    const webRequest = toWebRequest(req)
    const webResponse = await tusServer.handleWeb(webRequest)
    await fromWebResponse(webResponse, res)
  } catch (error) {
    console.error('[UPLOAD] Pages Router Error:', error)
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }
}
