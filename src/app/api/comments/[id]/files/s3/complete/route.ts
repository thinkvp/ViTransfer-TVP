/**
 * POST /api/comments/[id]/files/s3/complete
 *
 * Finalizes a browser-direct multipart upload to S3/R2 for a comment file.
 * Creates the CommentFile database record after S3 confirms the upload.
 *
 * Only available when STORAGE_PROVIDER=s3.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3CompleteMultipartUpload, type CompletedPart } from '@/lib/s3-storage'
import { verifyProjectAccess } from '@/lib/project-access'
import { prisma } from '@/lib/db'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const limited = await rateLimit(request, { maxRequests: 30, windowMs: 60_000 }, 'comment-s3-complete')
  if (limited) return limited

  const { id: commentId } = await params

  let comment: { id: string; projectId: string; isInternal: boolean; userId: string | null } | null
  let projectSettings: { id: string; sharePassword: string | null; authMode: string; allowClientUploadFiles: boolean } | null
  try {
    comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, projectId: true, isInternal: true, userId: true },
    })

    if (!comment) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    }

    projectSettings = await prisma.project.findUnique({
      where: { id: comment.projectId },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
        allowClientUploadFiles: true,
      },
    })

    if (!projectSettings) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
  } catch (error) {
    console.error('[COMMENT S3 COMPLETE] Failed to load comment/project:', error)
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

  const { uploadId, key, parts, fileSize, fileName, fileType } = body

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
  } catch (error) {
    console.error('[COMMENT S3 COMPLETE] Failed to complete multipart upload:', error)
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 })
  }

  const resolvedFileType = typeof fileType === 'string' && fileType.trim()
    ? fileType.trim()
    : 'application/octet-stream'

  try {
    const commentFile = await prisma.commentFile.create({
      data: {
        commentId,
        projectId: comment.projectId,
        fileName,
        fileSize: BigInt(fileSize),
        fileType: resolvedFileType,
        storagePath: key,
      },
    })

    await recalculateAndStoreProjectTotalBytes(comment.projectId)

    console.log(`[COMMENT S3 COMPLETE] Comment file ${commentFile.id} upload complete`)
    return NextResponse.json({
      success: true,
      file: {
        id: commentFile.id,
        fileName: commentFile.fileName,
        fileSize: Number(commentFile.fileSize),
        storagePath: commentFile.storagePath,
        createdAt: commentFile.createdAt,
      },
    })
  } catch (error) {
    console.error('[COMMENT S3 COMPLETE] S3 upload succeeded but DB record creation failed — orphaned object at key:', key, error)
    return NextResponse.json({ error: 'Upload completed but failed to save file record' }, { status: 500 })
  }
}
