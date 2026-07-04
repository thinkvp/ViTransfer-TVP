/**
 * POST /api/users/[id]/files/s3/complete
 *
 * Finalizes a browser-direct multipart upload to S3/R2 for a user file.
 * Creates the UserFile database record and queues it for processing.
 *
 * Only available when STORAGE_PROVIDER=s3.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3CompleteMultipartUpload, type CompletedPart } from '@/lib/s3-storage'
import { requireApiAuth, getCurrentUserFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { registerStoredFile } from '@/lib/stored-file'
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
    { windowMs: 60_000, maxRequests: 30, message: 'Too many requests' },
    'user-files-s3-complete'
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

  const currentUser = await getCurrentUserFromRequest(request)
  if (!currentUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { uploadId, key, parts, fileSize, fileName, fileType, category } = body

  if (!uploadId || typeof uploadId !== 'string') {
    return NextResponse.json({ error: 'uploadId is required' }, { status: 400 })
  }
  if (!key || typeof key !== 'string') {
    return NextResponse.json({ error: 'key is required' }, { status: 400 })
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    return NextResponse.json({ error: 'parts array is required' }, { status: 400 })
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize is required' }, { status: 400 })
  }
  if (!fileName || typeof fileName !== 'string') {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
  }

  const completedParts: CompletedPart[] = parts.map((p: any) => ({
    PartNumber: Number(p.partNumber),
    ETag: String(p.etag),
  }))

  try {
    await s3CompleteMultipartUpload(key, uploadId, completedParts)
  } catch (err) {
    console.error('[USER FILES S3 COMPLETE] Failed to complete multipart upload:', err)
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 })
  }

  const resolvedFileType =
    typeof fileType === 'string' && fileType.trim() ? fileType.trim() : 'application/octet-stream'
  const resolvedCategory =
    typeof category === 'string' && category.trim() ? category.trim() : 'other'

  // Entity row + StoredFile registration commit atomically so a partial failure
  // can't leave a UserFile without its registration.
  let record
  try {
    record = await prisma.$transaction(async (tx) => {
      const created = await tx.userFile.create({
        data: {
          userId,
          fileName,
          fileType: resolvedFileType,
          category: resolvedCategory,
          uploadedBy: currentUser.id,
          uploadedByName: currentUser.name || currentUser.email,
        },
        select: { id: true },
      })
      await registerStoredFile({
        entityType: 'USER_FILE', entityId: created.id, fileRole: 'ORIGINAL',
        storagePath: key, fileName, fileSize: BigInt(fileSize),
      }, tx)
      return created
    })
  } catch (err) {
    // The object is already in R2 — log the key so the orphan is traceable.
    console.error(`[USER FILES S3 COMPLETE] Upload completed but DB registration failed — unregistered object at ${key}:`, err)
    return NextResponse.json({ error: 'Failed to record upload' }, { status: 500 })
  }

  const { getUserFileQueue } = await import('@/lib/queue')
  const q = getUserFileQueue()
  await q.add('process-user-file', {
    userFileId: record.id,
    storagePath: key,
    expectedCategory: resolvedCategory,
  })

  console.log(`[USER FILES S3 COMPLETE] User file ${record.id} upload complete`)
  return NextResponse.json({ userFileId: record.id })
}
