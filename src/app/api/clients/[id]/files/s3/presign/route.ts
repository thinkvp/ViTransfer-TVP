/**
 * POST /api/clients/[id]/files/s3/presign
 *
 * Initiates a browser-direct multipart upload to S3/R2 for a client file,
 * returning presigned PUT URLs for each part.
 *
 * Only available when STORAGE_PROVIDER=s3.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3InitiateMultipartUpload, s3GetPresignedPartUrl, S3_PRESIGNED_PART_EXPIRES_SECONDS } from '@/lib/s3-storage'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { validateAssetFile } from '@/lib/file-validation'
import { buildClientFilesStoragePath } from '@/lib/project-storage-paths'
import { prisma } from '@/lib/db'

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
    'client-files-s3-presign'
  )
  if (limited) return limited

  const { id: clientId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClientFiles')
  if (forbiddenAction) return forbiddenAction

  const client = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null },
    select: { id: true, name: true },
  })
  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { fileName, fileSize, contentType } = body

  if (!fileName || typeof fileName !== 'string') {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 })
  }

  const fileValidation = validateAssetFile(fileName, contentType || 'application/octet-stream')
  if (!fileValidation.valid) {
    return NextResponse.json({ error: fileValidation.error || 'Invalid file' }, { status: 400 })
  }

  const sanitizedFileName =
    fileValidation.sanitizedFilename || fileName.replace(/[^a-zA-Z0-9 ._&-]/g, '_').substring(0, 255)
  const timestamp = Date.now()
  const s3Key = buildClientFilesStoragePath(client.name, sanitizedFileName, timestamp)
  const category = fileValidation.detectedCategory || 'other'

  const partSize = calculatePartSize(fileSize)
  const partCount = Math.ceil(fileSize / partSize)

  let s3UploadId: string
  try {
    s3UploadId = await s3InitiateMultipartUpload(s3Key, contentType || 'application/octet-stream')
  } catch (err) {
    console.error('[CLIENT FILES S3 PRESIGN] Failed to initiate multipart upload:', err)
    return NextResponse.json({ error: 'Failed to initiate upload' }, { status: 500 })
  }

  const parts: Array<{ partNumber: number; url: string }> = []
  for (let i = 0; i < partCount; i++) {
    const url = await s3GetPresignedPartUrl(s3Key, s3UploadId, i + 1, S3_PRESIGNED_PART_EXPIRES_SECONDS)
    parts.push({ partNumber: i + 1, url })
  }

  return NextResponse.json({
    uploadId: s3UploadId,
    key: s3Key,
    parts,
    partSize,
    sanitizedFileName,
    category,
  })
}
