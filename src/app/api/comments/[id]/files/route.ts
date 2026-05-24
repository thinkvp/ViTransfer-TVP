import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { validateCommentFile, generateCommentFilePath, MAX_FILES_PER_COMMENT } from '@/lib/fileUpload'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { checkProjectUploadQuota } from '@/lib/project-upload-quota'
import { uploadFile } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: commentId } = await params

    // Get the comment to verify it exists and get project ID
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { 
        id: true, 
        projectId: true, 
        isInternal: true,
        userId: true 
      },
    })

    if (!comment) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    }

    // Verify project exists and get upload settings
    const projectSettings = await prisma.project.findUnique({
      where: { id: comment.projectId },
      select: { 
        id: true,
        sharePassword: true,
        authMode: true,
        allowClientUploadFiles: true,
        maxClientUploadAllocationMB: true,
      },
    })

    if (!projectSettings) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Authenticate with share token
    const authResult = await verifyProjectAccess(request, comment.projectId, projectSettings.sharePassword, projectSettings.authMode)
    if (!authResult.authorized) {
      return authResult.errorResponse!
    }

    // Check if user is admin or client
    const isAdmin = authResult.isAdmin
    const isClient = !isAdmin && authResult.isAuthenticated

    // Clients can only upload to their own comments (non-internal)
    if (isClient && (comment.isInternal || comment.userId)) {
      return NextResponse.json(
        { error: 'You do not have permission to upload files to this comment' },
        { status: 403 }
      )
    }

    // Rate limiting: 10 file uploads per minute per IP
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 10,
      message: 'Too many file uploads. Please try again later.'
    }, 'comment-file-upload')
    
    if (rateLimitResult) {
      return rateLimitResult
    }

    // Parse the incoming FormData
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const uploadIntent = String(formData.get('uploadIntent') || '').toLowerCase()
    const isVoiceNoteUpload = uploadIntent === 'voice-note'

    // Check if file uploads are allowed for this project (only applies to clients).
    // Voice notes are intentionally always allowed.
    if (isClient && !projectSettings.allowClientUploadFiles && !isVoiceNoteUpload) {
      return NextResponse.json(
        { error: 'File uploads are not allowed for this project' },
        { status: 403 }
      )
    }

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      )
    }

    // Validate file
    const fileSize = file.size
    const mimeType = file.type
    const fileName = file.name

    const validation = validateCommentFile(fileName, mimeType, fileSize)
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      )
    }

    // Enforce per-project total allocation for client uploads (0 = unlimited)
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

    // Enforce max files per comment
    const existingCount = await prisma.commentFile.count({
      where: { commentId },
    })

    if (existingCount >= MAX_FILES_PER_COMMENT) {
      return NextResponse.json(
        { error: `A maximum of ${MAX_FILES_PER_COMMENT} files can be attached to a comment.` },
        { status: 400 }
      )
    }

    const projectStorage = await prisma.project.findUnique({
      where: { id: comment.projectId },
      select: {
        storagePath: true,
        title: true,
        companyName: true,
        client: { select: { name: true } },
      },
    })

    // Generate storage path
    const projectStoragePath = projectStorage?.storagePath
      || buildProjectStorageRoot(projectStorage?.client?.name || projectStorage?.companyName || 'Client', projectStorage?.title || 'Untitled')
    const storagePath = generateCommentFilePath(projectStoragePath, commentId, fileName)

    // Upload to storage (local disk or R2 depending on STORAGE_PROVIDER)
    const buffer = Buffer.from(await file.arrayBuffer())
    await uploadFile(storagePath, buffer, fileSize, mimeType)

    // Save file metadata to database
    const commentFile = await prisma.commentFile.create({
      data: {
        commentId,
        projectId: comment.projectId,
        fileName,
        fileSize: BigInt(fileSize),
        fileType: mimeType,
        storagePath,
      },
    })

    await recalculateAndStoreProjectTotalBytes(comment.projectId)

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
    console.error('Error uploading comment file:', error)
    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    )
  }
}

// DELETE endpoint to remove a file from a comment (before sending the comment)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: commentId } = await params

    // Get the comment
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { 
        id: true, 
        projectId: true, 
        isInternal: true,
        userId: true,
        files: true
      },
    })

    if (!comment) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    }

    // Load project auth settings and authenticate
    const project = await prisma.project.findUnique({
      where: { id: comment.projectId },
      select: {
        sharePassword: true,
        authMode: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const authResult = await verifyProjectAccess(
      request,
      comment.projectId,
      project.sharePassword,
      project.authMode
    )
    if (!authResult.authorized) {
      return authResult.errorResponse!
    }

    const isAdmin = authResult.isAdmin
    const isClient = !isAdmin && authResult.isAuthenticated

    // Clients can only delete from their own non-internal comments
    if (isClient && (comment.isInternal || comment.userId)) {
      return NextResponse.json(
        { error: 'You do not have permission to delete files from this comment' },
        { status: 403 }
      )
    }

    if (comment.files.length === 0) {
      return NextResponse.json(
        { error: 'No file attached to this comment' },
        { status: 404 }
      )
    }

    // Delete file from database (file storage cleanup can be done separately)
    await prisma.commentFile.deleteMany({
      where: { commentId },
    })

    await recalculateAndStoreProjectTotalBytes(comment.projectId)

    return NextResponse.json({
      success: true,
      message: 'File removed from comment',
    })
  } catch (error) {
    console.error('Error deleting comment file:', error)
    return NextResponse.json(
      { error: 'Failed to delete file' },
      { status: 500 }
    )
  }
}
