import { type NextRequest, NextResponse } from 'next/server'
import {
  isS3Mode,
  s3InitiateMultipartUpload,
  s3GetPresignedPartUrl,
  S3_PRESIGNED_PART_EXPIRES_SECONDS,
} from '@/lib/s3-storage'
import { rateLimit } from '@/lib/rate-limit'
import { validateCommentFile } from '@/lib/fileUpload'
import { resolveProjectStoragePath, resolveShareUploadAccess } from '@/lib/share-uploads'
import {
  allocateUniqueUploadFileName,
  normalizeProjectUploadRelativePath,
} from '@/lib/project-storage-paths'
import { checkProjectUploadQuota } from '@/lib/project-upload-quota'
import { prisma } from '@/lib/db'
import { resolveUploadFolderStoragePath } from '@/lib/share-upload-folder-storage'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_PART_SIZE_BYTES = 16 * 1024 * 1024
const MAX_PART_SIZE_BYTES = 256 * 1024 * 1024
const MAX_PARTS = 10_000

function calculatePartSize(fileSize: number): number {
  let partSize = MIN_PART_SIZE_BYTES
  while (Math.ceil(fileSize / partSize) > MAX_PARTS && partSize < MAX_PART_SIZE_BYTES) {
    partSize = Math.min(partSize * 2, MAX_PART_SIZE_BYTES)
  }
  return partSize
}

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
    { windowMs: 60_000, maxRequests: 30, message: 'Too many upload requests' },
    `share-uploads-s3-presign:${token}`,
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

  const fileName = String(body?.fileName || '').trim()
  const fileSize = Number(body?.fileSize || 0)
  const folderPathRaw = String(body?.folderPath || '').trim()
  const contentType = typeof body?.contentType === 'string' && body.contentType.trim()
    ? body.contentType.trim()
    : 'application/octet-stream'

  if (!fileName) {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 })
  }

  const validation = validateCommentFile(fileName, contentType, fileSize)
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

  const normalizedFolderPath = normalizeProjectUploadRelativePath(folderPathRaw)
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
  const folderStoragePath = await resolveUploadFolderStoragePath({
    projectId: access.project.id,
    projectStoragePath,
    folderRelativePath: normalizedFolderPath,
  })
  const key = path.posix.join(folderStoragePath, storageFileName)

  const partSize = calculatePartSize(fileSize)
  const partCount = Math.ceil(fileSize / partSize)

  let uploadId: string
  try {
    uploadId = await s3InitiateMultipartUpload(key, contentType)
  } catch (error) {
    console.error('[SHARE UPLOADS S3 PRESIGN] Failed to initiate multipart upload:', error)
    return NextResponse.json({ error: 'Failed to initiate upload' }, { status: 500 })
  }

  const parts = await Promise.all(
    Array.from({ length: partCount }, (_, i) =>
      s3GetPresignedPartUrl(key, uploadId, i + 1, S3_PRESIGNED_PART_EXPIRES_SECONDS)
    )
  )

  return NextResponse.json({
    uploadId,
    key,
    partSize,
    folderPath: normalizedFolderPath,
    fileName,
    fileType: contentType,
    parts: parts.map((url, i) => ({ partNumber: i + 1, url })),
  })
}
