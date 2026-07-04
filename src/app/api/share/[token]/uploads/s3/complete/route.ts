import { type NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { isS3Mode, s3CompleteMultipartUpload, type CompletedPart } from '@/lib/s3-storage'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import {
  buildProjectUploadsRoot,
  normalizeProjectUploadRelativePath,
} from '@/lib/project-storage-paths'
import { resolveProjectStoragePath, resolveShareUploadAccess } from '@/lib/share-uploads'
import { resolveUploadFolderStoragePath } from '@/lib/share-upload-folder-storage'
import { parseShareUploadMediaMetadata } from '@/lib/share-upload-media-metadata'
import { isShareUploadImageFileType, isShareUploadVideoFileType } from '@/lib/share-upload-video-thumbnail'
import { enqueueShareUploadPreview, getUploadTimelineQueue } from '@/lib/queue'
import { registerStoredFile } from '@/lib/stored-file'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const { token } = await params

  const limited = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many requests' },
    `share-uploads-s3-complete:${token}`,
  )
  if (limited) return limited

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canUpload) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const uploadId = String(body?.uploadId || '').trim()
  const key = String(body?.key || '').trim()
  const fileName = String(body?.fileName || '').trim()
  const fileType = String(body?.fileType || 'application/octet-stream').trim() || 'application/octet-stream'
  const folderPath = normalizeProjectUploadRelativePath(String(body?.folderPath || '').trim())
  const fileSize = Number(body?.fileSize || 0)
  const partsInput = Array.isArray(body?.parts) ? body.parts : []
  const mediaMetadata = parseShareUploadMediaMetadata(body?.mediaMetadata)

  if (!uploadId) {
    return NextResponse.json({ error: 'uploadId is required' }, { status: 400 })
  }
  if (!key) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 })
  }
  if (!fileName) {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 })
  }
  if (!Array.isArray(partsInput) || partsInput.length === 0) {
    return NextResponse.json({ error: 'parts array is required' }, { status: 400 })
  }

  const projectStoragePath = resolveProjectStoragePath(access.project)
  const uploadsRoot = buildProjectUploadsRoot(projectStoragePath)
  if (key !== uploadsRoot && !key.startsWith(`${uploadsRoot}/`)) {
    return NextResponse.json({ error: 'Invalid upload key' }, { status: 400 })
  }

  const completedParts: CompletedPart[] = partsInput.map((part: any) => ({
    PartNumber: Number(part.partNumber),
    ETag: String(part.etag),
  }))
  const storedFileName = path.posix.basename(key)

  try {
    await s3CompleteMultipartUpload(key, uploadId, completedParts)
  } catch (error) {
    console.error('[SHARE UPLOADS S3 COMPLETE] Failed to complete multipart upload:', error)
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 })
  }

  // Entity row + StoredFile registration commit atomically: a partial failure must not
  // leave a ShareUploadFile without its registration (invisible to reconciliation).
  let createdFile
  try {
    createdFile = await prisma.$transaction(async (tx) => {
      const created = await tx.shareUploadFile.create({
        data: {
          projectId: access.project.id,
          folderRelativePath: folderPath,
          fileName: storedFileName || fileName,
          fileType,
          mediaDurationSeconds: mediaMetadata?.durationSeconds ?? null,
          mediaWidth: mediaMetadata?.width ?? null,
          mediaHeight: mediaMetadata?.height ?? null,
          mediaCodec: mediaMetadata?.codec ?? null,
          uploadedByName: access.isAdmin ? 'Admin' : 'Client',
        },
        select: {
          id: true,
          folderRelativePath: true,
          fileName: true,
          fileType: true,
          createdAt: true,
        },
      })
      await registerStoredFile({
        entityType: 'SHARE_UPLOAD_FILE',
        entityId: created.id,
        fileRole: 'ORIGINAL',
        storagePath: key,
        fileName: storedFileName || fileName,
        fileSize: BigInt(fileSize),
        projectId: access.project.id,
      }, tx)
      return created
    })
  } catch (error) {
    // The object is already in R2 — log the key so the orphan is traceable.
    console.error(`[SHARE UPLOADS S3 COMPLETE] Upload completed but DB registration failed — unregistered object at ${key}:`, error)
    return NextResponse.json({ error: 'Failed to record upload' }, { status: 500 })
  }

  if (folderPath) {
    const folderStoragePath = await resolveUploadFolderStoragePath({
      projectId: access.project.id,
      projectStoragePath,
      folderRelativePath: folderPath,
    })
    await prisma.shareUploadFolder.upsert({
      where: {
        projectId_relativePath: {
          projectId: access.project.id,
          relativePath: folderPath,
        },
      },
      update: {},
      create: {
        projectId: access.project.id,
        relativePath: folderPath,
        folderName: folderPath.split('/').pop() || folderPath,
        storagePath: folderStoragePath,
        createdByName: access.isAdmin ? 'Admin' : 'Client',
      },
    })
  }

  await recalculateAndStoreProjectTotalBytes(access.project.id)

  if (isShareUploadImageFileType(fileType) || isShareUploadVideoFileType(fileType)) {
    void enqueueShareUploadPreview({
      type: 'shareUploadFile',
      recordId: createdFile.id,
      storagePath: key,
      fileType,
      fileName: storedFileName || fileName,
      durationSeconds: mediaMetadata?.durationSeconds ?? null,
    }).catch((e) => console.warn('[PREVIEW] Failed to enqueue preview after S3 complete:', e))

    // Also enqueue timeline sprite generation for video uploads
    // (processor probes metadata when duration/width/height are 0)
    if (isShareUploadVideoFileType(fileType)) {
      const uploadTimelineQueue = getUploadTimelineQueue()
      void uploadTimelineQueue.add('process-upload-timeline', {
        uploadFileId: createdFile.id,
        projectId: access.project.id,
        storagePath: key,
        durationSeconds: mediaMetadata?.durationSeconds ?? 0,
        width: mediaMetadata?.width ?? 0,
        height: mediaMetadata?.height ?? 0,
      }).catch((e) => console.warn('[TIMELINE] Failed to enqueue upload timeline after S3 complete:', e))
    }
  }

  return NextResponse.json({
    success: true,
    file: {
      ...createdFile,
      fileSize: fileSize,
    },
  })
}
