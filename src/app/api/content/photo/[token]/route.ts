import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import { rateLimit } from '@/lib/rate-limit'
import { getClientIpAddress } from '@/lib/utils'
import { createReadStream, existsSync, statSync } from 'fs'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { getAuthContext } from '@/lib/auth'
import { getSecuritySettings } from '@/lib/video-access'
import { verifyAlbumPhotoAccessToken } from '@/lib/photo-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function createWebReadableStream(fileStream: NodeJS.ReadableStream): ReadableStream {
  return new ReadableStream({
    start(controller) {
      fileStream.on('data', (chunk) => controller.enqueue(chunk))
      fileStream.on('end', () => controller.close())
      fileStream.on('error', (err) => controller.error(err))
    },
    cancel() {
      ;(fileStream as any).destroy?.()
    },
  })
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const { searchParams } = new URL(request.url)
  const isDownload = searchParams.get('download') === 'true'
  const variant = searchParams.get('variant')

  const rateLimitResult = await rateLimit(
    request,
    // Album grids can legitimately trigger hundreds of image requests quickly.
    // Keep a high limit here; access is still gated by per-photo tokens.
    { windowMs: 60 * 1000, maxRequests: 3000, message: 'Too many requests. Please slow down.' },
    'photo-content-ip'
  )
  if (rateLimitResult) return rateLimitResult

  const redis = getRedis()
  const rawTokenData = await redis.get(`photo_access:${token}`)
  if (!rawTokenData) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const preliminary = JSON.parse(rawTokenData)
  const sessionId = preliminary?.sessionId
  if (!sessionId) return NextResponse.json({ error: 'Access denied' }, { status: 401 })

  const authContext = await getAuthContext(request)
  const isAdminRequest = authContext.isAdmin || String(sessionId).startsWith('admin:')

  const verified = await verifyAlbumPhotoAccessToken({ token, request, sessionId })
  if (!verified) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  // For admin sessions, ensure project still exists.
  if (isAdminRequest) {
    const project = await prisma.project.findUnique({ where: { id: verified.projectId }, select: { id: true } })
    if (!project) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const photo = await prisma.albumPhoto.findUnique({
    where: { id: verified.photoId },
    include: { album: { select: { projectId: true } } },
  })

  if (!photo || photo.albumId !== verified.albumId || photo.album.projectId !== verified.projectId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 404 })
  }

  if (photo.status !== 'READY') {
    return NextResponse.json({ error: 'Photo not ready' }, { status: 404 })
  }

  let storagePath = photo.storagePath
  if (variant === 'social') {
    if (photo.socialStatus !== 'READY' || !photo.socialStoragePath) {
      return NextResponse.json({ error: 'Social photo not ready' }, { status: 409 })
    }
    storagePath = photo.socialStoragePath
  }

  const fullPath = getFilePath(storagePath)
  if (!existsSync(fullPath)) return NextResponse.json({ error: 'Access denied' }, { status: 404 })

  const stat = statSync(fullPath)
  const fileStream = createReadStream(fullPath)
  const readableStream = createWebReadableStream(fileStream)

  const filename = sanitizeFilenameForHeader(photo.fileName || 'photo.jpg')

  if (isDownload) {
    const settings = await getSecuritySettings()
    if (settings.trackAnalytics && sessionId && !sessionId.startsWith('admin:')) {
      const downloadVariant = variant === 'social' ? 'social' : 'full'
      await prisma.albumAnalytics.create({
        data: {
          projectId: verified.projectId,
          albumId: verified.albumId,
          photoId: verified.photoId,
          eventType: 'PHOTO_DOWNLOAD',
          variant: downloadVariant,
          sessionId,
          ipAddress: getClientIpAddress(request) || undefined,
        },
      }).catch(() => {})
    }
  }

  return new NextResponse(readableStream, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': stat.size.toString(),
      // For album grids, allow the browser to cache images to avoid re-fetching during scroll/back/forward.
      // Tokens are already unguessable and scoped; keep caching private to the user agent.
      'Cache-Control': isDownload
        ? 'private, no-store, must-revalidate'
        : 'private, max-age=3600, immutable',
      'X-Content-Type-Options': 'nosniff',
      ...(isDownload ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  })
}
