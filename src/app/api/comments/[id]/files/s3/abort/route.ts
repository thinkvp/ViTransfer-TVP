/**
 * POST /api/comments/[id]/files/s3/abort
 *
 * Aborts an in-progress multipart upload for a comment file, releasing stored
 * parts on R2. Called when an upload is cancelled or fails.
 *
 * Only available when STORAGE_PROVIDER=s3.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3AbortMultipartUpload } from '@/lib/s3-storage'
import { verifyProjectAccess } from '@/lib/project-access'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const limited = await rateLimit(request, { maxRequests: 30, windowMs: 60_000 }, 'comment-s3-abort')
  if (limited) return limited

  const { id: commentId } = await params

  let comment: { id: string; projectId: string } | null
  let projectSettings: { sharePassword: string | null; authMode: string } | null
  try {
    comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, projectId: true },
    })

    if (!comment) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    }

    projectSettings = await prisma.project.findUnique({
      where: { id: comment.projectId },
      select: { sharePassword: true, authMode: true },
    })

    if (!projectSettings) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
  } catch (error) {
    console.error('[COMMENT S3 ABORT] Failed to load comment/project:', error)
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
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
    if (error?.name === 'NoSuchUpload' || error?.$metadata?.httpStatusCode === 404) {
      return NextResponse.json({ ok: true })
    }
    console.error('[COMMENT S3 ABORT] Failed to abort multipart upload:', error)
    return NextResponse.json({ error: 'Failed to abort upload' }, { status: 500 })
  }
}
