/**
 * POST /api/upload-s3/presign
 *
 * Initiates a browser-direct multipart upload to S3/R2 for a video, asset, or
 * album photo, returning presigned PUT URLs for each part.
 *
 * Only available when STORAGE_PROVIDER=s3.
 * Accepts videoId, assetId, or photoId in the request body.
 *
 * NOTE: This route lives at /api/upload-s3 (NOT /api/uploads/s3) because the
 * Pages API catch-all at /api/uploads/* intercepts all requests and passes them
 * to the TUS server, which doesn't recognize these S3 endpoints.
 */

import { type NextRequest, NextResponse } from 'next/server'
import {
  isS3Mode,
  s3InitiateMultipartUpload,
  s3GetPresignedPartUrl,
  S3_PRESIGNED_PART_EXPIRES_SECONDS,
} from '@/lib/s3-storage'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
// Handles VIDEO, VIDEO_ASSET, ALBUM_PHOTO — entity type resolved dynamically, no single projectId.
// eslint-disable-next-line no-restricted-imports
import { getStoredFilePath } from '@/lib/stored-file'

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

export async function POST(request: NextRequest) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const limited = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many upload requests' },
    'upload-s3-presign',
  )
  if (limited) return limited

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { videoId, assetId, photoId, fileSize, fileName, contentType } = body

  if (!videoId && !assetId && !photoId) {
    return NextResponse.json(
      { error: 'One of videoId, assetId, or photoId is required' },
      { status: 400 },
    )
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 })
  }
  if (!fileName || typeof fileName !== 'string') {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
  }

  const mimeType =
    typeof contentType === 'string' && contentType.trim()
      ? contentType.trim()
      : 'application/octet-stream'

  // Resolve the storage key from the StoredFile registry (created at entity creation time)
  const entityType = videoId ? 'VIDEO' : assetId ? 'VIDEO_ASSET' : 'ALBUM_PHOTO'
  const entityId = videoId || assetId || photoId

  const storagePath = await getStoredFilePath(entityType, entityId!, 'ORIGINAL')

  if (!storagePath) {
    return NextResponse.json(
      { error: 'File not found. The record may have been deleted and needs to be recreated.' },
      { status: 404 },
    )
  }

  const key = storagePath

  try {
    const uploadId = await s3InitiateMultipartUpload(key, mimeType)
    const partSize = calculatePartSize(fileSize)
    const partCount = Math.ceil(fileSize / partSize)

    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, i) =>
        s3GetPresignedPartUrl(key, uploadId, i + 1, S3_PRESIGNED_PART_EXPIRES_SECONDS),
      ),
    )

    return NextResponse.json({
      uploadId,
      key,
      parts: partUrls.map((url, i) => ({ partNumber: i + 1, url })),
      partSize,
    })
  } catch (error) {
    console.error('[UPLOAD S3 PRESIGN] Failed to initiate multipart upload:', error)
    return NextResponse.json({ error: 'Failed to initiate upload' }, { status: 500 })
  }
}
