import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import fs from 'fs'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
export const runtime = 'nodejs'




export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Rate limiting: 30 downloads per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: 'Too many download requests. Please slow down.'
  }, 'video-download')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id } = await params

    // Get video metadata
    const video = await prisma.video.findUnique({
      where: { id },
      include: { project: true },
    })

    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    // SECURITY: Verify user has access to this project (admin OR valid share session)
    const accessCheck = await verifyProjectAccess(request, video.project.id, video.project.sharePassword, video.project.authMode)
    if (!accessCheck.authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    if (!accessCheck.isAdmin) {
      if (!video.approved) {
        return NextResponse.json({ error: 'Downloads available after approval' }, { status: 403 })
      }
    }

    // Choose safest available file based on role/approval
    let filePath: string | null = null
    if (accessCheck.isAdmin) {
      filePath = video.originalStoragePath || video.preview1080Path || video.preview720Path || null
    } else {
      filePath = video.originalStoragePath || null
    }

    if (!filePath) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Get the full file path
    const fullPath = getFilePath(filePath)

    // Check if file exists and get stats
    const stat = await fs.promises.stat(fullPath)
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Use the original filename from the database, guard against missing values
    const originalFilename = video.originalFileName || 'video.mp4'
    const safeFilename = sanitizeFilenameForHeader(originalFilename)

    // Stream file with proper backpressure so large downloads don't buffer
    // the entire file in memory when the client is on a slow connection.
    const fileStream = createReadStream(fullPath)
    fileStream.pause()

    let ended = false
    let closed = false
    fileStream.once('end', () => { ended = true })

    const readableStream = new ReadableStream({
      pull(controller) {
        if (closed) return
        if (ended) {
          closed = true
          controller.close()
          return
        }

        return new Promise<void>((resolve) => {
          const onData = (chunk: Buffer | string) => {
            cleanup()
            fileStream.pause()
            if (!closed) {
              controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
            }
            resolve()
          }
          const onEnd = () => {
            cleanup()
            ended = true
            if (!closed) {
              closed = true
              controller.close()
            }
            resolve()
          }
          const onError = (err: Error) => {
            cleanup()
            if (!closed) {
              closed = true
              controller.error(err)
            }
            resolve()
          }
          const cleanup = () => {
            fileStream.removeListener('data', onData)
            fileStream.removeListener('end', onEnd)
            fileStream.removeListener('error', onError)
          }

          fileStream.once('data', onData)
          fileStream.once('end', onEnd)
          fileStream.once('error', onError)
          fileStream.resume()
        })
      },
      cancel() {
        closed = true
        fileStream.destroy()
      },
    })

    // Return file with proper headers for download
    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Content-Length': stat.size.toString(),
        // Security headers
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
      },
    })
  } catch (error) {
    console.error('Download error:', error)
    return NextResponse.json(
      { error: 'Failed to download file' },
      { status: 500 }
    )
  }
}
