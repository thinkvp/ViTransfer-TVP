import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { rateLimit } from '@/lib/rate-limit'
import { getRedis } from '@/lib/redis'
import { Readable } from 'stream'
import { createReadStream, existsSync, statSync } from 'fs'
import { getAlbumZipFileName, getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { getClientIpAddress } from '@/lib/utils'
import { getSecuritySettings } from '@/lib/video-access'
import { createTemporaryDropboxLink } from '@/lib/storage-provider-dropbox'
import { getTransferTuningSettings } from '@/lib/settings'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'

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
      sessionId?: string
    }

    const variant: 'full' | 'social' = tokenData.variant || 'full'
    const forceLocal = request.nextUrl.searchParams.get('forceLocal') === 'true'

    const album = await prisma.album.findUnique({
      where: { id: tokenData.albumId },
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
        dropboxEnabled: true,
        fullZipDropboxStatus: true,
        fullZipDropboxPath: true,
        socialZipDropboxStatus: true,
        socialZipDropboxPath: true,
        project: {
          select: {
            storagePath: true,
            title: true,
            companyName: true,
            client: { select: { name: true } },
          },
        },
      },
    })
    if (!album || album.projectId !== tokenData.projectId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const projectStoragePath = album.project.storagePath
      || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
    const albumFolderName = album.storageFolderName || album.name

    // If Dropbox copy is complete, redirect to Dropbox for direct download
    const dbxStatus = variant === 'full' ? album.fullZipDropboxStatus : album.socialZipDropboxStatus
    const dbxPath = variant === 'full' ? album.fullZipDropboxPath : album.socialZipDropboxPath
    if (!forceLocal && album.dropboxEnabled && dbxStatus === 'COMPLETE' && dbxPath) {
      try {
        const settings = await getSecuritySettings()
        if (settings.trackAnalytics && tokenData.sessionId && !tokenData.sessionId.startsWith('admin:')) {
          await prisma.albumAnalytics.create({
            data: {
              projectId: album.projectId,
              albumId: album.id,
              eventType: 'ALBUM_DOWNLOAD',
              variant,
              sessionId: tokenData.sessionId,
              ipAddress: getClientIpAddress(request) || undefined,
              details: { source: 'Dropbox' },
            },
          }).catch(() => {})
        }

        const dropboxUrl = await createTemporaryDropboxLink('', dbxPath)
        return NextResponse.redirect(dropboxUrl, {
          status: 307,
          headers: {
            'Cache-Control': 'private, no-store, must-revalidate',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
          },
        })
      } catch {
        // Fall through to local streaming if Dropbox link fails
      }
    }

    const zipStoragePath = getAlbumZipStoragePath({
      projectStoragePath,
      albumFolderName,
      albumName: album.name,
      variant,
    })
    const zipFullPath = getFilePath(zipStoragePath)
    if (!existsSync(zipFullPath)) {
      return NextResponse.json({ error: 'ZIP not ready yet' }, { status: 409 })
    }

    const settings = await getSecuritySettings()
    if (settings.trackAnalytics && tokenData.sessionId && !tokenData.sessionId.startsWith('admin:')) {
      await prisma.albumAnalytics.create({
        data: {
          projectId: album.projectId,
          albumId: album.id,
          eventType: 'ALBUM_DOWNLOAD',
          variant,
          sessionId: tokenData.sessionId,
          ipAddress: getClientIpAddress(request) || undefined,
        },
      }).catch(() => {})
    }

    const stat = statSync(zipFullPath)
    const { downloadChunkSizeBytes } = await getTransferTuningSettings()
    const fileStream = createReadStream(zipFullPath, { highWaterMark: downloadChunkSizeBytes })
    const readableStream = Readable.toWeb(fileStream as any) as ReadableStream

    const zipFilename = sanitizeFilenameForHeader(getAlbumZipFileName({ albumName: album.name, variant }))

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
