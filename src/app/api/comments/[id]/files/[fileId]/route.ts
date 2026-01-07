import { NextRequest, NextResponse } from 'next/server'
import { extname } from 'path'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import fs from 'fs'
import { createReadStream } from 'fs'

export const runtime = 'nodejs'
function isValidMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(trimmed)
}
export const dynamic = 'force-dynamic'

// MIME type map for common file types
const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.psd': 'image/vnd.adobe.photoshop',
  '.psb': 'image/vnd.adobe.photoshop',
  '.ai': 'application/vnd.adobe.illustrator',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  try {
    const { id: commentId, fileId } = await params

    // Get the comment file
    const commentFile = await prisma.commentFile.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        commentId: true,
        projectId: true,
        fileName: true,
        fileSize: true,
        fileType: true,
        storagePath: true,
        comment: {
          select: {
            projectId: true,
            isInternal: true,
            userId: true,
          },
        },
      },
    })

    if (!commentFile) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Verify the commentId matches
    if (commentFile.commentId !== commentId) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Get project for auth check
    const project = await prisma.project.findUnique({
      where: { id: commentFile.projectId },
      select: { sharePassword: true, authMode: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Authenticate with share token
    const authResult = await verifyProjectAccess(request, commentFile.projectId, project.sharePassword, project.authMode)
    if (!authResult.authorized) {
      return authResult.errorResponse!
    }

    const isAdmin = authResult.isAdmin
    const isClient = !isAdmin && authResult.isAuthenticated

    // Clients can only download files from non-internal comments
    if (isClient && commentFile.comment.isInternal) {
      return NextResponse.json(
        { error: 'You do not have permission to download this file' },
        { status: 403 }
      )
    }

    // Rate limiting: 30 downloads per minute
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many downloads. Please try again later.'
    }, 'comment-file-download')
    
    if (rateLimitResult) {
      return rateLimitResult
    }

    // Resolve and validate file path (prevents path traversal)
    let fullPath: string
    try {
      fullPath = getFilePath(commentFile.storagePath)
    } catch (err) {
      console.error('[COMMENT_FILE_DOWNLOAD] Invalid storage path', { fileId, storagePath: commentFile.storagePath })
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Verify file exists and is a file
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(fullPath)
      if (!stat.isFile()) {
        return NextResponse.json({ error: 'File not found on disk' }, { status: 404 })
      }
    } catch (err) {
      console.error(`File not found at path: ${fullPath}`, err)
      return NextResponse.json(
        { error: 'File not found on disk' },
        { status: 404 }
      )
    }

    // Determine MIME type
    const ext = extname(commentFile.fileName).toLowerCase()
    const mimeType = MIME_TYPES[ext] || (isValidMimeType(commentFile.fileType)
      ? commentFile.fileType
      : 'application/octet-stream')

    const safeFilename = sanitizeFilenameForHeader(commentFile.fileName)

    // Stream file to avoid loading into memory
    const fileStream = createReadStream(fullPath)

    const readableStream = new ReadableStream({
      start(controller) {
        fileStream.on('data', (chunk) => controller.enqueue(chunk))
        fileStream.on('end', () => controller.close())
        fileStream.on('error', (err) => controller.error(err))
      },
      cancel() {
        fileStream.destroy()
      },
    })

    // Return file with appropriate headers
    return new NextResponse(readableStream, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': stat.size.toString(),
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    })
  } catch (error) {
    console.error('Error downloading comment file:', error)
    return NextResponse.json(
      { error: 'Failed to download file' },
      { status: 500 }
    )
  }
}
