/**
 * POST /api/upload-s3/complete
 *
 * Finalizes a browser-direct multipart upload to S3/R2 for a video, asset, or
 * album photo. Updates entity status, creates/updates StoredFile records, and
 * enqueues processing jobs.
 *
 * Only available when STORAGE_PROVIDER=s3.
 * Accepts videoId, assetId, or photoId in the request body.
 *
 * NOTE: This route lives at /api/upload-s3 (NOT /api/uploads/s3) because the
 * Pages API catch-all at /api/uploads/* intercepts all requests and passes them
 * to the TUS server, which doesn't recognize these S3 endpoints.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3CompleteMultipartUpload, type CompletedPart } from '@/lib/s3-storage'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { finalizeAlbumPhotoUpload } from '@/lib/album-photo-upload-finalize'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const limited = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many requests' },
    'upload-s3-complete',
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

  const { videoId, assetId, photoId, uploadId, key, parts } = body

  if (!videoId && !assetId && !photoId) {
    return NextResponse.json(
      { error: 'One of videoId, assetId, or photoId is required' },
      { status: 400 },
    )
  }
  if (!uploadId || typeof uploadId !== 'string') {
    return NextResponse.json({ error: 'uploadId is required' }, { status: 400 })
  }
  if (!key || typeof key !== 'string') {
    return NextResponse.json({ error: 'key is required' }, { status: 400 })
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    return NextResponse.json({ error: 'parts array is required' }, { status: 400 })
  }

  const completedParts: CompletedPart[] = parts.map((p: any) => ({
    PartNumber: Number(p.partNumber),
    ETag: String(p.etag),
  }))

  // Complete the multipart upload on S3/R2
  try {
    await s3CompleteMultipartUpload(key, uploadId, completedParts)
  } catch (error) {
    console.error('[UPLOAD S3 COMPLETE] Failed to complete multipart upload:', error)
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 })
  }

  try {
    if (videoId) {
      return await handleVideoComplete(videoId, key)
    } else if (assetId) {
      return await handleAssetComplete(assetId, key)
    } else if (photoId) {
      return await handlePhotoComplete(photoId)
    }
    // Should never reach here due to validation above
    return NextResponse.json({ error: 'Invalid entity type' }, { status: 400 })
  } catch (error) {
    console.error('[UPLOAD S3 COMPLETE] S3 upload succeeded but post-processing failed:', error)
    return NextResponse.json(
      { error: 'Upload completed but failed to finalize record' },
      { status: 500 },
    )
  }
}

async function handleVideoComplete(videoId: string, key: string) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { id: true, projectId: true, status: true },
  })

  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 })
  }

  // Update video status to QUEUED — upload is complete and the job is waiting in the worker queue
  await prisma.video.update({
    where: { id: videoId },
    data: {
      status: 'QUEUED',
      processingProgress: 0,
    },
  })

  // Check if project is CLOSED with auto-delete previews enabled
  const [projectRecord, globalSettings] = await Promise.all([
    prisma.project.findUnique({ where: { id: video.projectId }, select: { status: true } }),
    prisma.settings.findUnique({ where: { id: 'default' }, select: { autoDeletePreviewsOnClose: true } }),
  ])

  const skipPreviews =
    projectRecord?.status === 'CLOSED' && !!globalSettings?.autoDeletePreviewsOnClose

  const { getVideoQueue } = await import('@/lib/queue')
  const vq = getVideoQueue()

  await vq.add('process-video', {
    videoId: video.id,
    originalStoragePath: key,
    projectId: video.projectId,
    ...(skipPreviews ? { thumbnailOnly: true } : {}),
  })

  await recalculateAndStoreProjectTotalBytes(video.projectId)

  console.log(`[UPLOAD S3 COMPLETE] Video ${videoId} upload complete, queued for processing`)
  return NextResponse.json({ success: true })
}

async function handleAssetComplete(assetId: string, key: string) {
  const asset = await prisma.videoAsset.findUnique({
    where: { id: assetId },
    select: { id: true, videoId: true, category: true },
  })

  if (!asset) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
  }

  // Do not trust client-supplied MIME; worker will set verified type after magic-byte validation
  await prisma.videoAsset.update({
    where: { id: assetId },
    data: {
      fileType: 'application/octet-stream',
    },
  })

  // Queue asset for magic byte validation in worker
  const { getAssetQueue } = await import('@/lib/queue')
  const assetQueue = getAssetQueue()

  await assetQueue.add('process-asset', {
    assetId: asset.id,
    storagePath: key,
    expectedCategory: asset.category ?? undefined,
  })

  console.log(`[UPLOAD S3 COMPLETE] Asset ${assetId} upload complete, queued for processing`)
  return NextResponse.json({ success: true })
}

async function handlePhotoComplete(photoId: string) {
  const finalized = await finalizeAlbumPhotoUpload(photoId)
  if (!finalized.ok) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 })
  }

  console.log(`[UPLOAD S3 COMPLETE] Album photo ${photoId} upload complete`)
  return NextResponse.json({ success: true })
}
