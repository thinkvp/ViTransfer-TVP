import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import { rateLimit } from '@/lib/rate-limit'
import { getClientIpAddress } from '@/lib/utils'
import { createReadStream, existsSync, statSync } from 'fs'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { getStoredFilePath } from '@/lib/stored-file'
import { getAuthContext } from '@/lib/auth'
import { getSecuritySettings } from '@/lib/video-access'
import { verifyAlbumPhotoAccessToken } from '@/lib/photo-access'
import { getTransferTuningSettings } from '@/lib/settings'
import { isS3Mode, s3FileExists, s3GetPresignedDownloadUrl, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { createWebReadableStream } from '@/lib/stream-utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

  // Get paths from StoredFile
  const origPath = await getStoredFilePath('ALBUM_PHOTO', photo.id, 'ORIGINAL')
  const socialPath = await getStoredFilePath('ALBUM_PHOTO', photo.id, 'SOCIAL')
  const thumbPath = await getStoredFilePath('ALBUM_PHOTO', photo.id, 'THUMBNAIL')

  let storagePath = origPath
  if (variant === 'social') {
    if (photo.socialStatus !== 'READY' || !socialPath) {
      return NextResponse.json({ error: 'Social photo not ready' }, { status: 409 })
    }
    storagePath = socialPath
  }

  async function streamInlineImage(candidateStoragePath: string): Promise<NextResponse | null> {
    const exists = isS3Mode()
      ? await s3FileExists(candidateStoragePath)
      : existsSync(getFilePath(candidateStoragePath))

    if (!exists) return null

    const { downloadChunkSizeBytes } = await getTransferTuningSettings()

    if (isS3Mode()) {
      const presignedUrl = await s3GetPresignedStreamUrl(candidateStoragePath, 14400, 'image/jpeg')
      return NextResponse.redirect(presignedUrl, { status: 302, headers: { 'Cache-Control': 'no-store' } })
    }

    const fullPath = getFilePath(candidateStoragePath)
    const stat = statSync(fullPath)
    const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })
    return new NextResponse(createWebReadableStream(fileStream), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': stat.size.toString(),
        'Cache-Control': 'private, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    })
  }

  if (variant === 'thumbnail') {
    if (photo.thumbnailStatus === 'READY' && thumbPath) {
      const thumbnailResponse = await streamInlineImage(thumbPath)
      if (thumbnailResponse) return thumbnailResponse
    }

    if (photo.socialStatus === 'READY' && socialPath) {
      const previewResponse = await streamInlineImage(socialPath)
      if (previewResponse) return previewResponse
    }
    // Fall through to the original as a graceful last resort.
  }

  if (variant === 'preview') {
    if (photo.socialStatus === 'READY' && socialPath) {
      const previewResponse = await streamInlineImage(socialPath)
      if (previewResponse) return previewResponse
    }
    // Social derivative not ready yet — fall through and serve the original as a graceful fallback.
  }

  if (!storagePath) return NextResponse.json({ error: 'Access denied' }, { status: 404 })

  // Check the target file exists before streaming.
  if (isS3Mode()) {
    const exists = await s3FileExists(storagePath)
    if (!exists) return NextResponse.json({ error: 'Access denied' }, { status: 404 })
  } else {
    const fullPath = getFilePath(storagePath)
    if (!existsSync(fullPath)) return NextResponse.json({ error: 'Access denied' }, { status: 404 })
  }

  const { downloadChunkSizeBytes } = await getTransferTuningSettings()
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

  if (isS3Mode()) {
    const presignedUrl = isDownload
      ? await s3GetPresignedDownloadUrl(storagePath, 300, photo.fileName || 'photo.jpg', 'image/jpeg')
      : await s3GetPresignedStreamUrl(storagePath, 14400, 'image/jpeg')
    return NextResponse.redirect(presignedUrl, { status: 302, headers: { 'Cache-Control': 'no-store' } })
  }

  const fullPath = getFilePath(storagePath)
  const stat = statSync(fullPath)
  const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })
  const readableStream = createWebReadableStream(fileStream)

  return new NextResponse(readableStream, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': stat.size.toString(),
      'Cache-Control': isDownload
        ? 'private, no-store, must-revalidate'
        : 'private, max-age=3600, immutable',
      'X-Content-Type-Options': 'nosniff',
      ...(isDownload ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  })
}
