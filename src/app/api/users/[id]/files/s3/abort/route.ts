/**
 * POST /api/users/[id]/files/s3/abort
 *
 * Aborts an in-progress multipart upload for a user file, releasing stored
 * parts on R2. Called when an upload is cancelled or fails.
 *
 * Only available when STORAGE_PROVIDER=s3.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3AbortMultipartUpload } from '@/lib/s3-storage'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const limited = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests' },
    'user-files-s3-abort'
  )
  if (limited) return limited

  const { id: userId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'users')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

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
  } catch (err: any) {
    if (err?.name === 'NoSuchUpload' || err?.$metadata?.httpStatusCode === 404) {
      return NextResponse.json({ ok: true })
    }
    console.error('[USER FILES S3 ABORT] Failed to abort multipart upload:', err)
    return NextResponse.json({ error: 'Failed to abort upload' }, { status: 500 })
  }
}
