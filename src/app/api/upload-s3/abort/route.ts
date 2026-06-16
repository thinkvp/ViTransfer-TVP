/**
 * POST /api/upload-s3/abort
 *
 * Aborts an in-progress multipart upload for a video, asset, or album photo,
 * releasing stored parts on R2. Called when an upload is cancelled or fails.
 *
 * Only available when STORAGE_PROVIDER=s3.
 * Accepts videoId, assetId, or photoId in the request body.
 *
 * NOTE: This route lives at /api/upload-s3 (NOT /api/uploads/s3) because the
 * Pages API catch-all at /api/uploads/* intercepts all requests and passes them
 * to the TUS server, which doesn't recognize these S3 endpoints.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3AbortMultipartUpload } from '@/lib/s3-storage'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const limited = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests' },
    'upload-s3-abort',
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

  const { uploadId, key } = body

  if (!uploadId || typeof uploadId !== 'string') {
    return NextResponse.json({ error: 'uploadId is required' }, { status: 400 })
  }
  if (!key || typeof key !== 'string') {
    return NextResponse.json({ error: 'key is required' }, { status: 400 })
  }

  try {
    await s3AbortMultipartUpload(key, uploadId)
    return NextResponse.json({ ok: true })
  } catch (error: any) {
    // NoSuchUpload is not a real error — the upload was already cleaned up
    if (error?.name === 'NoSuchUpload' || error?.$metadata?.httpStatusCode === 404) {
      return NextResponse.json({ ok: true })
    }
    console.error('[UPLOAD S3 ABORT] Failed to abort multipart upload:', error)
    return NextResponse.json({ error: 'Failed to abort upload' }, { status: 500 })
  }
}
