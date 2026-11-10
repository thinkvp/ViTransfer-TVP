import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { getSecuritySettings, logSecurityEvent } from '@/lib/video-access'
import { sendPushNotification } from '@/lib/push-notifications'
import { getClientIpAddress } from '@/lib/utils'
import { getRedis } from '@/lib/redis'
import { isLikelyAdminIp } from '@/lib/admin-ip-match'
import { touchProjectLastAccessForRequest } from '@/lib/project-last-access'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import { buildAlbumPhotoPayloads, enqueueMissingAlbumZips, getAlbumZipReadiness } from '@/lib/album-share'
import {
  GUEST_ALBUM_VIEW_DEDUPE_SECONDS,
  guestAlbumLinkSessionId,
  noStore,
  resolveGuestAlbumLink,
} from '@/lib/guest-album-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/guest-album-links/[token]
 *
 * Public endpoint (no auth): resolves a guest album token into the album + photo payload
 * the shared album viewer renders. Unlike guest video links, downloads are allowed (single
 * photos and the pre-built album ZIPs).
 *
 * One request per page load: thumbnails and previews come back presigned direct-to-bucket in
 * S3 mode, so opening a large album does not fan out into per-photo app requests (CrowdSec).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please try again later.' },
    'guest-album-link-view'
  )
  if (rateLimitResult) return rateLimitResult

  const { token } = await params
  const resolved = await resolveGuestAlbumLink(token)
  if (!resolved.ok) return resolved.response
  const { link } = resolved
  const album = link.album
  const project = link.project

  const sessionId = guestAlbumLinkSessionId(link.token)
  const ipAddress = getClientIpAddress(request)

  const albumPhotos = await prisma.albumPhoto.findMany({
    where: { albumId: album.id, status: 'READY' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, fileName: true, createdAt: true, thumbnailStatus: true, socialStatus: true },
  })

  // Visibility on the security dashboard for every open (best-effort).
  await logSecurityEvent({
    type: 'GUEST_ALBUM_LINK_VIEWED',
    severity: 'INFO',
    projectId: project.id,
    sessionId,
    ipAddress,
    referer: request.headers.get('referer') || undefined,
    details: {
      projectTitle: project.title,
      albumId: album.id,
      albumName: album.name,
      token: link.token,
      userAgent: request.headers.get('user-agent') || 'Unknown',
    },
  }).catch(() => {})

  // Analytics + admin notification, skipped when the visitor is likely an internal user testing
  // the link. Deduped per (link, IP) so reloads don't spam the bell or the activity feed — guest
  // links share one sessionId across every viewer, so dedupe can't be session-based.
  const likelyAdmin = await isLikelyAdminIp(ipAddress).catch(() => false)
  if (!likelyAdmin) {
    await touchProjectLastAccessForRequest({ projectId: project.id, request, sessionId }).catch(() => {})

    const redis = getRedis()
    const dedupeKey = `analytics:guest_album_view:${link.token}:${ipAddress || 'unknown'}`
    const firstView = await redis
      .set(dedupeKey, '1', 'EX', GUEST_ALBUM_VIEW_DEDUPE_SECONDS, 'NX')
      .then((res) => res === 'OK')
      .catch(() => false)

    if (firstView) {
      const settings = await getSecuritySettings().catch(() => null)
      if (settings?.trackAnalytics !== false) {
        await prisma.albumAnalytics.create({
          data: {
            projectId: project.id,
            albumId: album.id,
            eventType: 'ALBUM_VIEW',
            sessionId,
            ipAddress: ipAddress || undefined,
          },
        }).catch(() => {})
      }

      await sendPushNotification({
        type: 'GUEST_ALBUM_LINK_ACCESS',
        projectId: project.id,
        projectName: project.title,
        title: 'Guest Album Link Access',
        message: 'A guest opened an album guest link.',
        details: {
          Project: project.title,
          Album: album.name,
          IP: ipAddress,
        },
      }).catch(() => {})
    }
  }

  const photos = await buildAlbumPhotoPayloads({
    photos: albumPhotos,
    albumId: album.id,
    projectId: project.id,
    request,
    sessionId,
  })

  if (albumPhotos.some((p) => p.thumbnailStatus !== 'READY')) {
    void enqueueAlbumThumbnailJob({ albumId: album.id, delayMs: 500 }).catch(() => {})
  }

  const zip = photos.length === 0 ? { fullReady: false, socialReady: false } : await getAlbumZipReadiness(album)
  if (photos.length > 0) await enqueueMissingAlbumZips(album, zip)

  return noStore(NextResponse.json({
    expiresAt: link.expiresAt,
    project: { title: project.title },
    album: {
      id: album.id,
      name: album.name,
      notes: album.notes,
      createdAt: album.createdAt,
      photoCount: photos.length,
      socialCopiesEnabled: album.socialCopiesEnabled,
      zip,
    },
    photos,
  }))
}
