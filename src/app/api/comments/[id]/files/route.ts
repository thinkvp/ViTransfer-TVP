import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { validateCommentFile, generateCommentFilePath, MAX_FILES_PER_COMMENT } from '@/lib/fileUpload'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_ROOT = process.env.STORAGE_ROOT || '/app/uploads'

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
    const project = await prisma.project.findUnique({
      where: { id: comment.projectId },
      select: { 
        id: true,
        sharePassword: true,
        authMode: true,
        allowClientUploadFiles: true,
        maxClientUploadAllocationMB: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Authenticate with share token
    const authResult = await verifyProjectAccess(request, comment.projectId, project.sharePassword, project.authMode)
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

    // Check if file uploads are allowed for this project (only applies to clients)
    if (isClient && !project.allowClientUploadFiles) {
      return NextResponse.json(
        { error: 'File uploads are not allowed for this project' },
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
    if (isClient && (project.maxClientUploadAllocationMB ?? 0) > 0) {
      const limitBytes = BigInt(project.maxClientUploadAllocationMB) * BigInt(1024 * 1024)
      const used = await prisma.commentFile.aggregate({
        where: { projectId: comment.projectId },
        _sum: { fileSize: true },
      })
      const usedBytes = (used._sum.fileSize ?? BigInt(0)) as bigint
      const incomingBytes = BigInt(fileSize)

      if (usedBytes + incomingBytes > limitBytes) {
        const remainingBytes = usedBytes >= limitBytes ? BigInt(0) : (limitBytes - usedBytes)
        const remainingMB = Number(remainingBytes / BigInt(1024 * 1024))
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

    // Generate storage path
    const storagePath = generateCommentFilePath(comment.projectId, commentId, fileName)
    const fullPath = join(STORAGE_ROOT, storagePath)
    const directory = fullPath.substring(0, fullPath.lastIndexOf('/'))

    // Create directory if it doesn't exist
    await mkdir(directory, { recursive: true })

    // Write file to disk
    const buffer = await file.arrayBuffer()
    await writeFile(fullPath, Buffer.from(buffer))

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
