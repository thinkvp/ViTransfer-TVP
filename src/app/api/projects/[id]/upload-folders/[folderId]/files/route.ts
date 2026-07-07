import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { validateCommentFile } from '@/lib/fileUpload'
import { uploadFile } from '@/lib/storage'
import { allocateUniqueUploadFileName } from '@/lib/project-storage-paths'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import {
  resolveUploadFolderStoragePath,
  deleteUploadFile,
} from '@/lib/share-upload-folder-storage'
import {
  authorizeUploadFolders,
  resolveUploadFolderProjectStoragePath,
} from '@/lib/project-upload-folders-admin'
import { parseShareUploadMediaMetadata } from '@/lib/share-upload-media-metadata'
import { registerStoredFile } from '@/lib/stored-file'
import { isShareUploadImageFileType, isShareUploadVideoFileType } from '@/lib/share-upload-video-thumbnail'
import { enqueueShareUploadPreview, getUploadTimelineQueue } from '@/lib/queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/projects/[id]/upload-folders/[folderId]/files - admin file upload into a folder
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; folderId: string }> },
) {
  const { id: projectId, folderId } = await params

  const gate = await authorizeUploadFolders(request, projectId)
  if (gate.response) return gate.response
  const { auth, project } = gate

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many upload requests. Please slow down.' },
    'project-upload-folders-file-upload',
  )
  if (rateLimitResult) return rateLimitResult

  const folder = await prisma.shareUploadFolder.findFirst({
    where: { id: folderId, projectId },
    select: { relativePath: true },
  })
  if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 })

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  const mediaMetadataRaw = formData.get('mediaMetadata')

  let mediaMetadataJson: unknown = null
  if (typeof mediaMetadataRaw === 'string' && mediaMetadataRaw.trim()) {
    try {
      mediaMetadataJson = JSON.parse(mediaMetadataRaw)
    } catch {
      mediaMetadataJson = null
    }
  }
  const mediaMetadata = parseShareUploadMediaMetadata(mediaMetadataJson)

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  const folderRelativePath = folder.relativePath
  const fileName = String(file.name || '').trim()
  const fileSize = Number(file.size || 0)
  const mimeType = String(file.type || 'application/octet-stream')

  if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'Invalid file payload' }, { status: 400 })
  }

  const validation = validateCommentFile(fileName, mimeType, fileSize)
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error || 'File type is not allowed' }, { status: 400 })
  }

  // Note: admin uploads are NOT subject to the client upload quota
  // (`maxClientUploadAllocationMB`), which only governs client-originated uploads.

  const projectStoragePath = resolveUploadFolderProjectStoragePath(project)
  const existingFilesInFolder = await prisma.shareUploadFile.findMany({
    where: { projectId, folderRelativePath },
    select: { fileName: true },
  })
  const existingNames = existingFilesInFolder.map((entry) => entry.fileName)
  const storageFileName = allocateUniqueUploadFileName(fileName, existingNames)
  const folderStoragePath = await resolveUploadFolderStoragePath({
    projectId,
    projectStoragePath,
    folderRelativePath,
  })
  // eslint-disable-next-line no-restricted-syntax -- appending filename to DB-resolved folder path
  const storagePath = path.posix.join(folderStoragePath, storageFileName)

  const buffer = Buffer.from(await file.arrayBuffer())
  await uploadFile(storagePath, buffer, fileSize, mimeType)

  const createdFile = await prisma.shareUploadFile.create({
    data: {
      projectId,
      folderRelativePath,
      fileName: storageFileName,
      fileType: mimeType,
      mediaDurationSeconds: mediaMetadata?.durationSeconds ?? null,
      mediaWidth: mediaMetadata?.width ?? null,
      mediaHeight: mediaMetadata?.height ?? null,
      mediaCodec: mediaMetadata?.codec ?? null,
      uploadedById: auth.id,
      uploadedByName: auth.name || auth.email,
    },
    select: {
      id: true,
      folderRelativePath: true,
      fileName: true,
      fileType: true,
      previewStatus: true,
      createdAt: true,
    },
  })

  await registerStoredFile({
    entityType: 'SHARE_UPLOAD_FILE',
    entityId: createdFile.id,
    fileRole: 'ORIGINAL',
    storagePath,
    fileName: storageFileName,
    fileSize: BigInt(fileSize),
  })

  await recalculateAndStoreProjectTotalBytes(projectId)

  if (isShareUploadImageFileType(mimeType) || isShareUploadVideoFileType(mimeType)) {
    void enqueueShareUploadPreview({
      type: 'shareUploadFile',
      recordId: createdFile.id,
      storagePath,
      fileType: mimeType,
      fileName: storageFileName,
      durationSeconds: mediaMetadata?.durationSeconds ?? null,
    }).catch((e) => console.warn('[PREVIEW] Failed to enqueue preview after admin upload:', e))

    if (isShareUploadVideoFileType(mimeType)) {
      const uploadTimelineQueue = getUploadTimelineQueue()
      void uploadTimelineQueue.add('process-upload-timeline', {
        uploadFileId: createdFile.id,
        projectId,
        storagePath,
        durationSeconds: mediaMetadata?.durationSeconds ?? 0,
        width: mediaMetadata?.width ?? 0,
        height: mediaMetadata?.height ?? 0,
      }).catch((e) => console.warn('[TIMELINE] Failed to enqueue upload timeline after admin upload:', e))
    }
  }

  return NextResponse.json({
    success: true,
    file: { ...createdFile, fileSize },
  })
}

// DELETE /api/projects/[id]/upload-folders/[folderId]/files?fileId=... - delete a file (admin)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; folderId: string }> },
) {
  const { id: projectId } = await params

  const gate = await authorizeUploadFolders(request, projectId)
  if (gate.response) return gate.response

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'project-upload-folders-file-delete',
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const fileId = String(searchParams.get('fileId') || '').trim()
  if (!fileId) return NextResponse.json({ error: 'fileId is required' }, { status: 400 })

  const result = await deleteUploadFile({ projectId, fileId })
  if (!result.ok) {
    return NextResponse.json({ error: result.error || 'Failed to delete file' }, { status: result.status || 500 })
  }

  return NextResponse.json({ success: true })
}
