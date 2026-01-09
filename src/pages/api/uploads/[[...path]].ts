import { Server } from '@tus/server'
import { FileStore } from '@tus/file-store'
import { prisma } from '@/lib/db'
import { videoQueue } from '@/lib/queue'
import { ALL_ALLOWED_EXTENSIONS } from '@/lib/asset-validation'
import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import type { NextApiRequest, NextApiResponse } from 'next'

const TUS_UPLOAD_DIR = '/tmp/vitransfer-tus-uploads'

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

      if (!payload || payload.role !== 'ADMIN') {
        throw {
          status_code: 403,
          body: 'Admin access required'
        }
      }

      const videoId = upload.metadata?.videoId as string
      const assetId = upload.metadata?.assetId as string
      const clientFileId = upload.metadata?.clientFileId as string
      const projectFileId = upload.metadata?.projectFileId as string

      const declaredSize = Number(upload.size)
      if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
        throw {
          status_code: 400,
          body: 'Upload size required'
        }
      }

      const maxUploadSizeBytes = await getMaxUploadSizeBytes()
      if (declaredSize > maxUploadSizeBytes) {
        throw {
          status_code: 413,
          body: `Upload exceeds max allowed size of ${Math.ceil(maxUploadSizeBytes / BYTES_PER_GB)}GB`
        }
      }

      if (!videoId && !assetId && !clientFileId && !projectFileId) {
        throw {
          status_code: 400,
          body: 'Missing required metadata: videoId, assetId, clientFileId, or projectFileId'
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

        if (video.status !== 'UPLOADING') {
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
    const projectFileId = upload.metadata?.projectFileId as string

    try {
      const maxUploadSizeBytes = await getMaxUploadSizeBytes()
      if (videoId) {
        return await handleVideoUploadFinish(tusFilePath, upload, videoId, tusServer, maxUploadSizeBytes)
      } else if (assetId) {
        return await handleAssetUploadFinish(tusFilePath, upload, assetId, tusServer, maxUploadSizeBytes)
      } else if (clientFileId) {
        return await handleClientFileUploadFinish(tusFilePath, upload, clientFileId, tusServer, maxUploadSizeBytes)
      } else if (projectFileId) {
        return await handleProjectFileUploadFinish(tusFilePath, upload, projectFileId, tusServer, maxUploadSizeBytes)
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
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size, maxUploadSizeBytes)

  await validateVideoFile(tusFilePath, upload.metadata?.filename as string)

  const { uploadFile, initStorage } = await import('@/lib/storage')
  await initStorage()

  const fileStream = (tusServer.datastore as any).read(upload.id)

  await uploadFile(
    video.originalStoragePath,
    fileStream,
    fileSize,
    upload.metadata?.filetype as string || 'video/mp4'
  )

  // Update video status to PROCESSING since upload is complete and job will be queued
  await prisma.video.update({
    where: { id: videoId },
    data: {
      status: 'PROCESSING',
      processingProgress: 0,
    },
  })

  console.log(`[UPLOAD] Video ${videoId} upload complete, status updated to PROCESSING`)

  await videoQueue.add('process-video', {
    videoId: video.id,
    originalStoragePath: video.originalStoragePath,
    projectId: video.projectId,
  })

  console.log(`[UPLOAD] Video ${videoId} queued for worker processing`)

  await cleanupTUSFile(tusFilePath)

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

  const { uploadFile, initStorage } = await import('@/lib/storage')
  await initStorage()

  const fileStream = (tusServer.datastore as any).read(upload.id)

  // Do not trust client-supplied MIME from upload metadata; worker will set verified type after magic-byte validation
  const actualFileType = 'application/octet-stream'
  await uploadFile(
    asset.storagePath,
    fileStream,
    fileSize,
    actualFileType
  )

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

  console.log(`[UPLOAD] Asset uploaded and queued for processing: ${assetId}`)

  await cleanupTUSFile(tusFilePath)

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

  const { uploadFile, initStorage } = await import('@/lib/storage')
  await initStorage()

  const fileStream = (tusServer.datastore as any).read(upload.id)

  // Do not trust client-supplied MIME; worker will set verified type after magic-byte validation
  const actualFileType = 'application/octet-stream'
  await uploadFile(
    clientFile.storagePath,
    fileStream,
    fileSize,
    actualFileType
  )

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

  await cleanupTUSFile(tusFilePath)
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

  const { uploadFile, initStorage } = await import('@/lib/storage')
  await initStorage()

  const fileStream = (tusServer.datastore as any).read(upload.id)

  // Do not trust client-supplied MIME; worker will set verified type after magic-byte validation
  const actualFileType = 'application/octet-stream'
  await uploadFile(
    projectFile.storagePath,
    fileStream,
    fileSize,
    actualFileType
  )

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

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '1000mb',
    responseLimit: false,
  },
  maxDuration: 3600,
}

function toWebRequest(req: NextApiRequest): Request {
  const rawProto = req.headers['x-forwarded-proto']
  const protoValue = (Array.isArray(rawProto) ? rawProto[0] : rawProto)?.split(',')[0]?.trim().toLowerCase()
  const protocol = protoValue === 'https' ? 'https' : 'http'

  const rawHost = req.headers['x-forwarded-host'] || req.headers.host
  const hostValue = (Array.isArray(rawHost) ? rawHost[0] : rawHost)?.split(',')[0]?.trim()

  // Accept only a conservative host[:port] shape.
  const safeHost = hostValue && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(hostValue) ? hostValue : 'localhost'

  const url = `${protocol}://${safeHost}${req.url || '/'}`

  const headers = new Headers()
  Object.entries(req.headers).forEach(([key, value]) => {
    if (value) {
      headers.set(key, Array.isArray(value) ? value[0] : value)
    }
  })

  let body: ReadableStream | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // @ts-ignore
    body = Readable.toWeb(req)
  }

  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body,
    // @ts-ignore
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

  res.end()
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const webRequest = toWebRequest(req)
    const webResponse = await tusServer.handleWeb(webRequest)
    await fromWebResponse(webResponse, res)
  } catch (error) {
    console.error('[UPLOAD] Pages Router Error:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}
