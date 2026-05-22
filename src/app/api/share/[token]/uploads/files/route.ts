import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { validateCommentFile } from '@/lib/fileUpload'
import { uploadFile } from '@/lib/storage'
import {
  allocateUniqueUploadFileName,
  buildProjectUploadFolderStoragePath,
  buildProjectUploadFileStoragePath,
  normalizeProjectUploadRelativePath,
} from '@/lib/project-storage-paths'
import { checkProjectUploadQuota } from '@/lib/project-upload-quota'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { resolveProjectStoragePath, resolveShareUploadAccess } from '@/lib/share-uploads'
import { parseShareUploadMediaMetadata } from '@/lib/share-upload-media-metadata'
import { ensureShareUploadPreview, isShareUploadImageFileType, isShareUploadVideoFileType } from '@/lib/share-upload-video-thumbnail'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many upload requests. Please slow down.' },
    `share-uploads-file-upload:${token}`,
  )
  if (rateLimitResult) return rateLimitResult

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canUpload) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  const folderPathRaw = String(formData.get('folderPath') || '').trim()
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

  const normalizedFolderPath = normalizeProjectUploadRelativePath(folderPathRaw)

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

  const quota = await checkProjectUploadQuota(
    access.project.id,
    access.project.maxClientUploadAllocationMB,
    BigInt(fileSize),
  )

  if (!quota.allowed) {
    const remainingMB = Number(quota.remainingBytes / BigInt(1024 * 1024))
    return NextResponse.json(
      { error: `Upload limit exceeded. Remaining allowance: ${remainingMB}MB.` },
      { status: 413 },
    )
  }

  const projectStoragePath = resolveProjectStoragePath(access.project)
  const existingFilesInFolder = await prisma.shareUploadFile.findMany({
    where: {
      projectId: access.project.id,
      folderRelativePath: normalizedFolderPath,
    },
    select: {
      storagePath: true,
    },
  })
  const existingNames = existingFilesInFolder.map((entry) => entry.storagePath.split('/').pop() || '')
  const storageFileName = allocateUniqueUploadFileName(fileName, existingNames)
  const storagePath = buildProjectUploadFileStoragePath(
    projectStoragePath,
    normalizedFolderPath,
    storageFileName,
  )

  const buffer = Buffer.from(await file.arrayBuffer())
  await uploadFile(storagePath, buffer, fileSize, mimeType)

  const createdFile = await prisma.shareUploadFile.create({
    data: {
      projectId: access.project.id,
      folderRelativePath: normalizedFolderPath,
      fileName: storageFileName,
      fileSize: BigInt(fileSize),
      fileType: mimeType,
      storagePath,
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
      fileSize: true,
      fileType: true,
      createdAt: true,
    },
  })

  if (normalizedFolderPath) {
    const folderStoragePath = buildProjectUploadFolderStoragePath(projectStoragePath, normalizedFolderPath)
    await prisma.shareUploadFolder.upsert({
      where: {
        projectId_relativePath: {
          projectId: access.project.id,
          relativePath: normalizedFolderPath,
        },
      },
      update: {
        storagePath: folderStoragePath,
      },
      create: {
        projectId: access.project.id,
        relativePath: normalizedFolderPath,
        folderName: normalizedFolderPath.split('/').pop() || normalizedFolderPath,
        storagePath: folderStoragePath,
        createdByName: access.isAdmin ? 'Admin' : 'Client',
      },
    })
  }

  await recalculateAndStoreProjectTotalBytes(access.project.id)

  if (isShareUploadVideoFileType(mimeType) || isShareUploadImageFileType(mimeType)) {
    // Best effort pre-generation so the first gallery view is usually already warm.
    void ensureShareUploadPreview({
      storagePath,
      fileName: storageFileName,
      fileType: mimeType,
      durationSeconds: mediaMetadata?.durationSeconds ?? null,
    })
  }

  return NextResponse.json({
    success: true,
    file: {
      ...createdFile,
      fileSize: Number(createdFile.fileSize),
    },
  })
}
