import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateThumbnail } from '@/lib/ffmpeg'
import sharp from 'sharp'
import {
  buildProjectUploadVideoThumbnailStoragePath,
  buildProjectStorageRoot,
} from '@/lib/project-storage-paths'
import { prisma } from '@/lib/db'
import { isS3Mode, s3FileExists, s3GetFileSize } from '@/lib/s3-storage'
import { getFilePath, uploadFile } from '@/lib/storage'
import { materializeStoragePathToLocalFile } from '@/lib/storage-provider'

const previewRequestMap = new Map<string, Promise<ShareUploadVideoThumbnailResult | null>>()

export interface ShareUploadVideoThumbnailResult {
  storagePath: string
  fileName: string
  fileSize: number
  fileType: 'image/jpeg'
}

export function isShareUploadImageFileType(fileType: string | null | undefined): boolean {
  return String(fileType || '').toLowerCase().startsWith('image/')
}

export function isShareUploadVideoFileType(fileType: string | null | undefined): boolean {
  return String(fileType || '').toLowerCase().startsWith('video/')
}

export function getShareUploadVideoThumbnailStoragePath(
  projectStoragePath: string,
  storagePath: string,
  fileType: string | null | undefined,
): string | null {
  if (!isShareUploadVideoFileType(fileType)) return null
  return buildProjectUploadVideoThumbnailStoragePath(projectStoragePath, storagePath)
}

export function getShareUploadPreviewStoragePath(
  projectStoragePath: string,
  storagePath: string,
  fileType: string | null | undefined,
): string | null {
  if (!isShareUploadVideoFileType(fileType) && !isShareUploadImageFileType(fileType)) {
    return null
  }
  return buildProjectUploadVideoThumbnailStoragePath(projectStoragePath, storagePath)
}

async function getStoredFileSize(storagePath: string): Promise<number | null> {
  if (isS3Mode()) {
    const size = await s3GetFileSize(storagePath)
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null
  }

  const absolutePath = getFilePath(storagePath)
  try {
    const stat = await fs.promises.stat(absolutePath)
    return stat.isFile() && stat.size > 0 ? stat.size : null
  } catch {
    return null
  }
}

async function thumbnailExists(storagePath: string): Promise<boolean> {
  if (isS3Mode()) {
    return s3FileExists(storagePath)
  }

  const absolutePath = getFilePath(storagePath)
  try {
    await fs.promises.access(absolutePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

function getThumbnailCaptureTimestamp(durationSeconds?: number | null): number {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 1
  }

  return Math.max(0.5, Math.min(10, durationSeconds * 0.12))
}

export async function ensureShareUploadVideoThumbnail(params: {
  projectStoragePath: string
  storagePath: string
  fileName: string
  fileType: string
  durationSeconds?: number | null
}): Promise<ShareUploadVideoThumbnailResult | null> {
  const thumbnailStoragePath = getShareUploadVideoThumbnailStoragePath(params.projectStoragePath, params.storagePath, params.fileType)
  if (!thumbnailStoragePath) return null

  const existingSize = await getStoredFileSize(thumbnailStoragePath)
  if (existingSize && existingSize > 0) {
    return {
      storagePath: thumbnailStoragePath,
      fileName: `${path.posix.basename(params.fileName || params.storagePath)}.jpg`,
      fileSize: existingSize,
      fileType: 'image/jpeg',
    }
  }

  const inFlight = previewRequestMap.get(thumbnailStoragePath)
  if (inFlight) return inFlight

  const task = (async (): Promise<ShareUploadVideoThumbnailResult | null> => {
    const alreadyExists = await thumbnailExists(thumbnailStoragePath)
    if (alreadyExists) {
      const fileSize = await getStoredFileSize(thumbnailStoragePath)
      if (fileSize && fileSize > 0) {
        return {
          storagePath: thumbnailStoragePath,
          fileName: `${path.posix.basename(params.fileName || params.storagePath)}.jpg`,
          fileSize,
          fileType: 'image/jpeg',
        }
      }
    }

    const tempDir = path.join(os.tmpdir(), 'vitransfer-share-upload-thumbnails', crypto.randomUUID())
    await fs.promises.mkdir(tempDir, { recursive: true })

    const materialized = await materializeStoragePathToLocalFile({
      rawPath: params.storagePath,
      tempDir,
      suggestedName: path.posix.basename(params.storagePath),
    })

    const thumbnailFilePath = path.join(tempDir, 'thumbnail.jpg')

    try {
      await generateThumbnail(
        materialized.localPath,
        thumbnailFilePath,
        getThumbnailCaptureTimestamp(params.durationSeconds),
      )

      const stat = await fs.promises.stat(thumbnailFilePath)
      if (!stat.isFile() || stat.size <= 0) {
        return null
      }

      const buffer = await fs.promises.readFile(thumbnailFilePath)
      await uploadFile(thumbnailStoragePath, buffer, stat.size, 'image/jpeg')

      return {
        storagePath: thumbnailStoragePath,
        fileName: `${path.posix.basename(params.fileName || params.storagePath)}.jpg`,
        fileSize: stat.size,
        fileType: 'image/jpeg',
      }
    } catch (error) {
      console.warn('[SHARE UPLOADS] Video thumbnail generation failed:', {
        storagePath: params.storagePath,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    } finally {
      if (materialized.isTemporary) {
        await fs.promises.rm(materialized.localPath, { force: true }).catch(() => undefined)
      }
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })().finally(() => {
    previewRequestMap.delete(thumbnailStoragePath)
  })

  previewRequestMap.set(thumbnailStoragePath, task)
  return task
}

export async function ensureShareUploadImagePreview(params: {
  projectStoragePath: string
  storagePath: string
  fileName: string
  fileType: string
}): Promise<ShareUploadVideoThumbnailResult | null> {
  if (!isShareUploadImageFileType(params.fileType)) return null

  const previewStoragePath = getShareUploadPreviewStoragePath(params.projectStoragePath, params.storagePath, params.fileType)
  if (!previewStoragePath) return null

  const existingSize = await getStoredFileSize(previewStoragePath)
  if (existingSize && existingSize > 0) {
    return {
      storagePath: previewStoragePath,
      fileName: `${path.posix.basename(params.fileName || params.storagePath)}.jpg`,
      fileSize: existingSize,
      fileType: 'image/jpeg',
    }
  }

  const inFlight = previewRequestMap.get(previewStoragePath)
  if (inFlight) return inFlight

  const task = (async (): Promise<ShareUploadVideoThumbnailResult | null> => {
    const tempDir = path.join(os.tmpdir(), 'vitransfer-share-upload-thumbnails', crypto.randomUUID())
    await fs.promises.mkdir(tempDir, { recursive: true })

    const materialized = await materializeStoragePathToLocalFile({
      rawPath: params.storagePath,
      tempDir,
      suggestedName: path.posix.basename(params.storagePath),
    })

    const previewFilePath = path.join(tempDir, 'thumbnail.jpg')

    try {
      await sharp(materialized.localPath)
        .rotate()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 76, mozjpeg: true })
        .toFile(previewFilePath)

      const stat = await fs.promises.stat(previewFilePath)
      if (!stat.isFile() || stat.size <= 0) {
        return null
      }

      const buffer = await fs.promises.readFile(previewFilePath)
      await uploadFile(previewStoragePath, buffer, stat.size, 'image/jpeg')

      return {
        storagePath: previewStoragePath,
        fileName: `${path.posix.basename(params.fileName || params.storagePath)}.jpg`,
        fileSize: stat.size,
        fileType: 'image/jpeg',
      }
    } catch (error) {
      console.warn('[SHARE UPLOADS] Image preview generation failed:', {
        storagePath: params.storagePath,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    } finally {
      if (materialized.isTemporary) {
        await fs.promises.rm(materialized.localPath, { force: true }).catch(() => undefined)
      }
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })().finally(() => {
    previewRequestMap.delete(previewStoragePath)
  })

  previewRequestMap.set(previewStoragePath, task)
  return task
}

export async function ensureShareUploadPreview(params: {
  projectStoragePath?: string | null
  storagePath: string
  fileName: string
  fileType: string
  durationSeconds?: number | null
}): Promise<ShareUploadVideoThumbnailResult | null> {
  const projectStoragePath = params.projectStoragePath ?? await resolveShareUploadProjectStoragePath(params.storagePath)

  if (isShareUploadVideoFileType(params.fileType)) {
    if (!projectStoragePath) return null
    return ensureShareUploadVideoThumbnail({ ...params, projectStoragePath })
  }
  if (isShareUploadImageFileType(params.fileType)) {
    if (!projectStoragePath) return null
    return ensureShareUploadImagePreview({ ...params, projectStoragePath })
  }
  return null
}

async function resolveShareUploadProjectStoragePath(storagePath: string): Promise<string | null> {
  const record = await prisma.shareUploadFile.findFirst({
    where: { storagePath },
    select: {
      project: {
        select: {
          storagePath: true,
          title: true,
          companyName: true,
          client: { select: { name: true } },
        },
      },
    },
  }).catch(() => null)

  const project = record?.project
  if (!project) return null
  return project.storagePath || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)
}
