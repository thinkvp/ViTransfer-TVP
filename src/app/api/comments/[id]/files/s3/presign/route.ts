/**
 * POST /api/comments/[id]/files/s3/presign
 *
 * Initiates a browser-direct multipart upload to S3/R2 for a comment file
 * attachment, returning presigned PUT URLs for each part.
 *
 * Only available when STORAGE_PROVIDER=s3.
 * Supports both admin bearer token auth and share-token (client) auth.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3InitiateMultipartUpload, s3GetPresignedPartUrl, S3_PRESIGNED_PART_EXPIRES_SECONDS } from '@/lib/s3-storage'
import { verifyProjectAccess } from '@/lib/project-access'
import { validateCommentFile, generateCommentFilePath, MAX_FILES_PER_COMMENT } from '@/lib/fileUpload'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { checkProjectUploadQuota } from '@/lib/project-upload-quota'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

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
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const limited = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many upload requests' },
    'comment-s3-presign'
  )
  if (limited) return limited

  const { id: commentId } = await params

  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, projectId: true, isInternal: true, userId: true },
  })

  if (!comment) {
    return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }

  const projectSettings = await prisma.project.findUnique({
    where: { id: comment.projectId },
    select: {
      id: true,
      sharePassword: true,
      authMode: true,
      allowClientUploadFiles: true,
      maxClientUploadAllocationMB: true,
      storagePath: true,
      title: true,
      companyName: true,
      client: { select: { name: true } },
    },
  })

  if (!projectSettings) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const authResult = await verifyProjectAccess(
    request,
    comment.projectId,
    projectSettings.sharePassword,
    projectSettings.authMode
  )
  if (!authResult.authorized) {
    return authResult.errorResponse!
  }

  const isAdmin = authResult.isAdmin
  const isClient = !isAdmin && authResult.isAuthenticated

  if (isClient && (comment.isInternal || comment.userId)) {
    return NextResponse.json(
      { error: 'You do not have permission to upload files to this comment' },
      { status: 403 }
    )
  }

  if (isClient && !projectSettings.allowClientUploadFiles) {
    return NextResponse.json(
      { error: 'File uploads are not allowed for this project' },
      { status: 403 }
    )
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { fileSize, fileName, contentType } = body

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 })
  }
  if (!fileName || typeof fileName !== 'string') {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
  }

  const mimeType = typeof contentType === 'string' && contentType.trim()
    ? contentType.trim()
    : 'application/octet-stream'

  const validation = validateCommentFile(fileName, mimeType, fileSize)
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  // Enforce per-project allocation for clients
  if (isClient && (projectSettings.maxClientUploadAllocationMB ?? 0) > 0) {
    const quota = await checkProjectUploadQuota(
      comment.projectId,
      projectSettings.maxClientUploadAllocationMB,
      BigInt(fileSize),
    )
    if (!quota.allowed) {
      const remainingMB = Number(quota.remainingBytes / BigInt(1024 * 1024))
      return NextResponse.json(
        { error: `Upload limit exceeded. Remaining allowance: ${remainingMB}MB.` },
        { status: 413 }
      )
    }
  }

  const existingCount = await prisma.commentFile.count({ where: { commentId } })
  if (existingCount >= MAX_FILES_PER_COMMENT) {
    return NextResponse.json(
      { error: `A maximum of ${MAX_FILES_PER_COMMENT} files can be attached to a comment.` },
      { status: 400 }
    )
  }

  const projectStoragePath = projectSettings.storagePath
    || buildProjectStorageRoot(
      projectSettings.client?.name || projectSettings.companyName || 'Client',
      projectSettings.title || 'Untitled'
    )
  const storagePath = generateCommentFilePath(projectStoragePath, commentId, fileName)

  try {
    const uploadId = await s3InitiateMultipartUpload(storagePath, mimeType)
    const partSize = calculatePartSize(fileSize)
    const partCount = Math.ceil(fileSize / partSize)

    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, i) =>
        s3GetPresignedPartUrl(storagePath, uploadId, i + 1, S3_PRESIGNED_PART_EXPIRES_SECONDS)
      )
    )

    return NextResponse.json({
      uploadId,
      key: storagePath,
      parts: partUrls.map((url, i) => ({ partNumber: i + 1, url })),
      partSize,
    })
  } catch (error) {
    console.error('[COMMENT S3 PRESIGN] Failed to initiate multipart upload:', error)
    return NextResponse.json({ error: 'Failed to initiate upload' }, { status: 500 })
  }
}
