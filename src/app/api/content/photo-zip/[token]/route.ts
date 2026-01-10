import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { downloadFile, getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { rateLimit } from '@/lib/rate-limit'
import { getRedis } from '@/lib/redis'
import { Readable } from 'stream'
import { existsSync, statSync } from 'fs'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params

    const rateLimitResult = await rateLimit(
      request,
      {
        windowMs: 60 * 1000,
        maxRequests: 30,
        message: 'Too many download requests. Please slow down.',
      },
      'photo-zip-download-ip'
    )
    if (rateLimitResult) return rateLimitResult

    const redis = getRedis()
    const raw = await redis.get(`photo_zip_download:${token}`)
    if (!raw) {
      return NextResponse.json({ error: 'Invalid or expired download link' }, { status: 403 })
    }

    const tokenData = JSON.parse(raw) as {
      projectId: string
      albumId: string
      variant?: 'full' | 'social'
    }

    const variant: 'full' | 'social' = tokenData.variant || 'full'

    const album = await prisma.album.findUnique({
      where: { id: tokenData.albumId },
      select: { id: true, projectId: true, name: true },
    })

    if (!album || album.projectId !== tokenData.projectId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const zipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant })
    const zipFullPath = getFilePath(zipStoragePath)
    if (!existsSync(zipFullPath)) {
      return NextResponse.json({ error: 'ZIP not ready yet' }, { status: 409 })
    }

    const stat = statSync(zipFullPath)
    const fileStream = await downloadFile(zipStoragePath)
    const readableStream = Readable.toWeb(fileStream as any) as ReadableStream

    const zipFilename = sanitizeFilenameForHeader(
      `${album.name.replace(/[^a-zA-Z0-9._-]/g, '_')}_photos${variant === 'social' ? '_social' : ''}.zip`
    )

    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename}"`,
        'Content-Length': stat.size.toString(),
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    console.error('Photo ZIP download error:', error)
    return NextResponse.json({ error: 'Download failed' }, { status: 500 })
  }
}
