/**
 * POST /api/clients/[id]/files/s3/complete
 *
 * Finalizes a browser-direct multipart upload to S3/R2 for a client file.
 * Creates the ClientFile database record and queues it for processing.
 *
 * Only available when STORAGE_PROVIDER=s3.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3CompleteMultipartUpload, type CompletedPart } from '@/lib/s3-storage'
import { requireApiAuth, getCurrentUserFromRequest } from '@/lib/auth'
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
    { windowMs: 60_000, maxRequests: 30, message: 'Too many requests' },
    'client-files-s3-complete'
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
    select: { id: true },
  })
  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 })
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
    console.error('[CLIENT FILES S3 COMPLETE] Failed to complete multipart upload:', err)
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 })
  }

  const resolvedFileType =
    typeof fileType === 'string' && fileType.trim() ? fileType.trim() : 'application/octet-stream'
  const resolvedCategory =
    typeof category === 'string' && category.trim() ? category.trim() : 'other'

  const record = await prisma.clientFile.create({
    data: {
      clientId,
      fileName,
      fileType: resolvedFileType,
      category: resolvedCategory,
      uploadedBy: currentUser.id,
      uploadedByName: currentUser.name || currentUser.email,
    },
    select: { id: true },
  })

  // Register in StoredFile
  await prisma.storedFile.create({ data: {
    entityType: 'CLIENT_FILE', entityId: record.id, fileRole: 'ORIGINAL',
    storagePath: key, fileName, fileSize: BigInt(fileSize),
  } })

  const { getClientFileQueue } = await import('@/lib/queue')
  const q = getClientFileQueue()
  await q.add('process-client-file', {
    clientFileId: record.id,
    storagePath: key,
    expectedCategory: resolvedCategory,
  })

  console.log(`[CLIENT FILES S3 COMPLETE] Client file ${record.id} upload complete`)
  return NextResponse.json({ clientFileId: record.id })
}
