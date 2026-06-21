import { NextRequest, NextResponse } from 'next/server'
import { verifyVideoAccessToken, detectHotlinking, logSecurityEvent, getSecuritySettings } from '@/lib/video-access'
import { getRedis } from '@/lib/redis'
import { prisma } from '@/lib/db'
import { createReadStream, existsSync, statSync } from 'fs'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { isS3Mode, s3FileExists, s3GetPresignedStreamUrl, s3GetPresignedDownloadUrl } from '@/lib/s3-storage'
// Token-based auth; entity types (VIDEO_ASSET, SHARE_UPLOAD_FILE) resolved via tokens, not projectId.
// eslint-disable-next-line no-restricted-imports
import { getStoredFilePath, getStoredFileRecords } from '@/lib/stored-file'
import {
  buildProjectStorageRoot,
  buildVideoAssetPreviewStoragePath,
  buildVideoAssetStoragePath,
  buildVideoOriginalStoragePath,
  buildVideoPreviewStoragePath,
  buildVideoThumbnailStoragePath,
  buildVideoTimelineStorageRoot,
} from '@/lib/project-storage-paths'
import { rateLimit } from '@/lib/rate-limit'
import { getClientIpAddress } from '@/lib/utils'
import { getAuthContext } from '@/lib/auth'
import { recordClientActivity } from '@/lib/client-activity'
import { registerTrackedDownload, recordTrackedDownloadProgress } from '@/lib/download-tracking'
import { getTransferTuningSettings } from '@/lib/settings'
import { createWebReadableStream } from '@/lib/stream-utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isValidMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(trimmed)
}

/**
 * Content delivery endpoint - streams video/thumbnail content with security checks
 * Handles both admin and share token authentication with rate limiting and hotlink protection
 * Supports range requests for video streaming and direct downloads
 *
 * @param request - NextRequest with authorization header and optional range header
 * @param params - Route params containing the video access token
 * @returns Video/thumbnail stream with appropriate headers, or error response
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const { searchParams } = new URL(request.url)
    const isDownload = searchParams.get('download') === 'true'
    const isProbe = searchParams.get('probe') === 'true'
    const assetId = searchParams.get('assetId')
    const wantsAssetGeneratedPreview = searchParams.get('assetPreview') === '1'
    const wantsAssetPlaybackPreview = searchParams.get('assetPlayback') === '1'
    const rawDownloadId = searchParams.get('downloadId')
    const downloadId = rawDownloadId && rawDownloadId.trim().length > 0 ? rawDownloadId.trim() : null
    const isAssetPreview = Boolean(assetId && !isDownload && wantsAssetGeneratedPreview)
    const isAssetPlaybackPreview = Boolean(assetId && !isDownload && wantsAssetPlaybackPreview)

    const securitySettings = await getSecuritySettings()

    const ipRateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: securitySettings.ipRateLimit,
      message: 'Too many requests from your network. Please slow down and try again later.'
    }, 'content-stream-ip')

    if (ipRateLimitResult) {
      await logSecurityEvent({
        type: 'RATE_LIMIT_HIT',
        severity: 'WARNING',
        ipAddress: getClientIpAddress(request),
        details: { limit: 'IP-based', window: '1 minute' },
        wasBlocked: true
      })

      return ipRateLimitResult
    }

    // Get authentication context once
    const authContext = await getAuthContext(request)

    const redis = getRedis()
    const tokenKey = `video_access:${token}`
    const rawTokenData = await redis.get(tokenKey)

    if (!rawTokenData) {
      // Distinguish expired download tokens from invalid tokens so clients
      // see a helpful message instead of a generic "Access denied".
      if (isDownload) {
        return NextResponse.json(
          { error: 'Download link has expired. Please go back and try downloading again.' },
          { status: 410 }
        )
      }
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const preliminaryTokenData = JSON.parse(rawTokenData)

    // Use token's session ID for all users
    const sessionId = preliminaryTokenData.sessionId

    // Determine if this is an admin request (JWT token OR admin session ID)
    const isAdminRequest = authContext.isAdmin || sessionId?.startsWith('admin:')

    // For admin users, verify they have access to the project
    if (isAdminRequest) {
      const project = await prisma.project.findUnique({
        where: { id: preliminaryTokenData.projectId },
        select: { id: true }
      })

      if (!project) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }

    if (!sessionId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 401 })
    }

    // Range requests (video scrubbing/seeking) are normal browser behaviour and are
    // already guarded by the IP rate limit, hotlink detection, and the per-video
    // frequency counter in detectHotlinking (>3000 req / 5 min). Only count
    // non-range requests (initial video loads, downloads, thumbnails) against the
    // session budget so that scrubbing never triggers a 429.
    const rangeHeader = request.headers.get('range')
    const isRangeRequest = !!rangeHeader

    if (!isRangeRequest) {
      const sessionCounterKey = `content-session-count:${sessionId}`
      const sessionCount = await redis.incr(sessionCounterKey)
      if (sessionCount === 1) {
        await redis.expire(sessionCounterKey, 60)
      }
      const effectiveSessionLimit = isAdminRequest
        ? securitySettings.sessionRateLimit
        : securitySettings.shareSessionRateLimit
      if (sessionCount > effectiveSessionLimit) {
        await logSecurityEvent({
          type: 'RATE_LIMIT_HIT',
          severity: 'INFO',
          projectId: preliminaryTokenData.projectId,
          sessionId,
          ipAddress: getClientIpAddress(request),
          details: { limit: 'Session-based', window: '1 minute' },
          wasBlocked: true
        })

        return NextResponse.json({
          error: 'Video streaming rate limit exceeded. Please wait a moment.'
        }, { status: 429, headers: { 'Retry-After': '60' } })
      }
    }

    const verifiedToken = await verifyVideoAccessToken(token, request, sessionId)

    if (!verifiedToken) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const hotlinkCheck = await detectHotlinking(
      request,
      sessionId,
      verifiedToken.videoId,
      verifiedToken.projectId
    )

    if (hotlinkCheck.isHotlinking) {
      if (securitySettings.hotlinkProtection === 'BLOCK_STRICT') {
        await logSecurityEvent({
          type: 'HOTLINK_BLOCKED',
          severity: hotlinkCheck.severity || 'WARNING',
          projectId: verifiedToken.projectId,
          videoId: verifiedToken.videoId,
          sessionId,
          ipAddress: getClientIpAddress(request),
          referer: request.headers.get('referer') || undefined,
          details: { reason: hotlinkCheck.reason },
          wasBlocked: true
        })
        
        return NextResponse.json({
          error: 'Access denied'
        }, { status: 403 })
      }
    }

    // Upload tokens use a placeholder videoId ('upload') — skip the video lookup.
    const isUploadEntity = verifiedToken.entityType === 'upload'

    const video = isUploadEntity
      ? null
      : await prisma.video.findUnique({
          where: { id: verifiedToken.videoId },
          include: { project: true },
        })

    if (!isUploadEntity && (!video || video.projectId !== verifiedToken.projectId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 404 })
    }

    // Resolve all file paths from StoredFile registry (single batch query)
    let storedPaths: Map<string, string> = new Map()
    let storedFileNames: Map<string, string> = new Map()
    if (!isUploadEntity && video) {
      const files = await getStoredFileRecords('VIDEO', [video.id], {
        select: { fileRole: true, storagePath: true, fileName: true },
      })
      storedPaths = new Map(files.map(f => [f.fileRole, f.storagePath]))
      for (const f of files) {
        if (f.fileRole === 'ORIGINAL' && f.fileName) {
          storedFileNames.set(f.fileRole, f.fileName)
        }
      }
    }

    const originalPath = storedPaths.get('ORIGINAL') ?? null
    let filePath: string | null = null
    let filename: string | null = storedFileNames.get('ORIGINAL') ?? null
    let contentType = 'video/mp4'
    let selectedAsset: { fileName: string } | null = null
    const canServeOriginal = Boolean(originalPath && (isAdminRequest || video?.approved))

    // Handle asset download or inline preview.
    // Upload entities don't have an associated video — reject early if a
    // maliciously-crafted request tries to reach this branch for an upload token.
    if (assetId) {
      if (!video) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
      const asset = await prisma.videoAsset.findUnique({
        where: { id: assetId }
      })

      if (!asset || asset.videoId !== video.id) {
        return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
      }

      // Check permissions (skip for admins)
      if (!isAdminRequest) {
        if (!video.approved) {
          return NextResponse.json({ error: 'Assets only available for approved videos' }, { status: 403 })
        }
      }

      contentType = isValidMimeType(asset.fileType)
        ? asset.fileType
        : 'application/octet-stream'
      const normalizedAssetType = typeof asset.fileType === 'string' ? asset.fileType.toLowerCase() : ''

      // Batch all asset StoredFile lookups into one query
      const assetFiles = await getStoredFileRecords('VIDEO_ASSET', [assetId], {
        select: { fileRole: true, storagePath: true },
      })
      const assetPaths = new Map(assetFiles.map(f => [f.fileRole, f.storagePath]))

      filePath = assetPaths.get('ORIGINAL') ?? null
      filename = asset.fileName
      selectedAsset = { fileName: asset.fileName }

      if (wantsAssetPlaybackPreview) {
        const previewPath = assetPaths.get('PREVIEW_MP4') ?? null
        const hasReadyGeneratedPreview =
          asset.previewStatus === 'READY'
          && previewPath
          && previewPath.toLowerCase().endsWith('.mp4')

        if (!hasReadyGeneratedPreview) {
          return NextResponse.json({ error: 'Preview not ready' }, { status: 404 })
        }

        filePath = previewPath
        filename = `${asset.fileName}.mp4`
        contentType = 'video/mp4'
        selectedAsset = null
      } else if (wantsAssetGeneratedPreview) {
        const previewPath = assetPaths.get('PREVIEW_IMAGE') ?? null
        const hasReadyGeneratedPreview =
          asset.previewStatus === 'READY'
          && (
            normalizedAssetType.startsWith('video/')
            || !!previewPath
          )

        if (!hasReadyGeneratedPreview) {
          return NextResponse.json({ error: 'Preview not ready' }, { status: 404 })
        }

        if (normalizedAssetType.startsWith('video/')) {
          const projectStoragePath = video.project.storagePath || buildProjectStorageRoot(
            (video.project as any).companyName || 'Client',
            video.project.title,
          )
          const assetOrigPath = assetPaths.get('ORIGINAL') || ''
          filePath = buildVideoAssetPreviewStoragePath(
            projectStoragePath,
            video.storageFolderName || video.name,
            video.versionLabel,
            assetOrigPath,
            '.jpg',
          )
        } else {
          filePath = previewPath
        }

        filename = `${asset.fileName}.jpg`
        contentType = 'image/jpeg'
        selectedAsset = { fileName: filename }
      }
    } else {
      // Upload entities only reach timeline-vtt/timeline-sprite sub-branches
      // (guarded by entityType checks that never dereference `video`).
      // All other quality branches are unreachable when video is null.
       
      const v = video!

      // Handle video download/stream
      if (verifiedToken.quality === 'thumbnail') {
        filePath = storedPaths.get('THUMBNAIL') ?? null
        contentType = 'image/jpeg'
      } else if (verifiedToken.quality === 'timeline-vtt') {
        // Handle asset/upload timeline previews
        if (verifiedToken.entityType === 'asset' && verifiedToken.entityId) {
          const asset = await prisma.videoAsset.findUnique({ where: { id: verifiedToken.entityId } })
          if (!asset || asset.videoId !== v.id) {
            return NextResponse.json({ error: 'Access denied' }, { status: 404 })
          }
          filePath = await getStoredFilePath('VIDEO_ASSET', verifiedToken.entityId, 'TIMELINE_VTT')
          if (!filePath) return NextResponse.json({ error: 'Access denied' }, { status: 404 })
          contentType = 'text/vtt'
        } else if (verifiedToken.entityType === 'upload' && verifiedToken.entityId) {
          filePath = await getStoredFilePath('SHARE_UPLOAD_FILE', verifiedToken.entityId, 'TIMELINE_VTT')
          if (!filePath) return NextResponse.json({ error: 'Access denied' }, { status: 404 })
          contentType = 'text/vtt'
        } else {
          if (!v.project.timelinePreviewsEnabled) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 })
          }
          filePath = storedPaths.get('TIMELINE_VTT') ?? null
          contentType = 'text/vtt'
        }
      } else if (verifiedToken.quality === 'timeline-sprite') {
        const spriteFile = searchParams.get('file')
        if (!spriteFile || !/^sprite-\d{3}\.jpg$/.test(spriteFile)) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 })
        }

        // Normalise a TIMELINE_SPRITES stored path to the directory prefix.
        // Workers store the directory; the orphan-backfill script may have stored
        // an individual sprite file before it was fixed.  Strip any trailing
        // sprite-NNN.jpg and ensure a trailing / so we can append the requested file.
        const spriteDir = (raw: string) => {
          const dir = raw.replace(/sprite-\d{3}\.jpg$/, '')
          return dir.endsWith('/') ? dir : `${dir}/`
        }

        // Handle asset/upload timeline previews
        if (verifiedToken.entityType === 'asset' && verifiedToken.entityId) {
          const asset = await prisma.videoAsset.findUnique({ where: { id: verifiedToken.entityId } })
          if (!asset || asset.videoId !== v.id) {
            return NextResponse.json({ error: 'Access denied' }, { status: 404 })
          }
          const rawPath = await getStoredFilePath('VIDEO_ASSET', verifiedToken.entityId, 'TIMELINE_SPRITES')
          if (!rawPath) return NextResponse.json({ error: 'Access denied' }, { status: 404 })
          filePath = `${spriteDir(rawPath)}${spriteFile}`
          contentType = 'image/jpeg'
        } else if (verifiedToken.entityType === 'upload' && verifiedToken.entityId) {
          const rawPath = await getStoredFilePath('SHARE_UPLOAD_FILE', verifiedToken.entityId, 'TIMELINE_SPRITES')
          if (!rawPath) return NextResponse.json({ error: 'Access denied' }, { status: 404 })
          filePath = `${spriteDir(rawPath)}${spriteFile}`
          contentType = 'image/jpeg'
        } else {
          if (!v.project.timelinePreviewsEnabled) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 })
          }
          const spritesBasePath = storedPaths.get('TIMELINE_SPRITES')
          if (!spritesBasePath) {
            return NextResponse.json({ error: 'Access denied' }, { status: 404 })
          }
          filePath = `${spriteDir(spritesBasePath)}${spriteFile}`
          contentType = 'image/jpeg'
        }
      } else if (verifiedToken.quality === 'original' || verifiedToken.quality === 'download') {
        if (canServeOriginal) {
          filePath = originalPath
        }
      } else if (verifiedToken.quality === '1080p') {
        filePath = storedPaths.get('PREVIEW_1080') || storedPaths.get('PREVIEW_720') || storedPaths.get('PREVIEW_480') || (canServeOriginal ? originalPath : null)
      } else if (verifiedToken.quality === '720p') {
        filePath = storedPaths.get('PREVIEW_720') || storedPaths.get('PREVIEW_1080') || storedPaths.get('PREVIEW_480') || (canServeOriginal ? originalPath : null)
      } else if (verifiedToken.quality === '480p') {
        filePath = storedPaths.get('PREVIEW_480') || storedPaths.get('PREVIEW_720') || storedPaths.get('PREVIEW_1080') || (canServeOriginal ? originalPath : null)
      }
    }

    if (!filePath) {
      return NextResponse.json({ error: 'Access denied' }, { status: 404 })
    }

    const isThumbnail = verifiedToken.quality === 'thumbnail'
    const isTimelineAsset = verifiedToken.quality === 'timeline-vtt' || verifiedToken.quality === 'timeline-sprite'

    if (!isAdminRequest && !isProbe) {
      const activityType = isDownload
        ? (assetId ? 'DOWNLOADING_ASSET' : 'DOWNLOADING_VIDEO')
        : (isAssetPreview ? null : (!isThumbnail && !isTimelineAsset ? 'STREAMING_VIDEO' : null))

      if (activityType) {
        // Fire-and-forget: activity tracking is analytics-only and must not
        // delay the response. Awaiting Redis ops here was adding latency before
        // the first response byte, which caused HAProxy to RST_STREAM on slow
        // Redis round-trips (observed after HAProxy 3.x upgrade).
         
        const v = video!
        void recordClientActivity({
          sessionId,
          projectId: v.projectId,
          projectTitle: v.project.title,
          videoId: v.id,
          videoName: v.name,
          versionLabel: v.versionLabel || null,
          assetId: assetId || null,
          assetName: filename || null,
          activityType,
          ipAddress: getClientIpAddress(request) || null,
          throttleKey: `${sessionId}:${v.id}:${assetId || verifiedToken.quality}:${activityType}`,
          throttleSeconds: 15,
        }).catch(() => undefined)
      }
    }

    if (isDownload && (isThumbnail || isTimelineAsset)) {
      return NextResponse.json({ error: 'Thumbnails cannot be downloaded directly' }, { status: 403 })
    }

    // ---------------------------------------------------------------------------
    // S3 mode: redirect to presigned R2 URL — no local file access needed
    // ---------------------------------------------------------------------------
    if (isS3Mode()) {
      const fileExists = await s3FileExists(filePath)
      if (!fileExists) {
        // File not found — no canonical fallback (StoredFile is the canonical path now)
        return NextResponse.json({ error: 'Access denied' }, { status: 404 })
      }

      let presignedUrl: string
      if (isDownload) {
         
        const v = video!
        const rawFilename = filename
          || `${v.project.title.replace(/[^a-z0-9]/gi, '_')}_${verifiedToken.quality}.mp4`
        const sanitizedFilename = sanitizeFilenameForHeader(rawFilename)
        const dlContentType = isThumbnail ? 'image/jpeg' : contentType
        presignedUrl = await s3GetPresignedDownloadUrl(filePath, 3600, sanitizedFilename, dlContentType)
      } else if (isThumbnail) {
        // Thumbnails, timeline VTT, and sprite images are all redirected to presigned
        // R2 URLs — offloading the transfer to R2. VTT is fetched from JS (CORS-sensitive)
        // but the R2 bucket has a CORS policy allowing GET from the app origin, so
        // redirecting is safe.
        presignedUrl = await s3GetPresignedStreamUrl(filePath, 900, contentType)
        return NextResponse.redirect(presignedUrl, {
          status: 302,
          headers: {
            'Cache-Control': 'private, max-age=300',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
          },
        })
      } else if (isTimelineAsset || isAssetPreview) {
        presignedUrl = await s3GetPresignedStreamUrl(filePath, 300, contentType)
        return NextResponse.redirect(presignedUrl, {
          status: 302,
          headers: {
            'Cache-Control': isAssetPreview ? 'no-store' : 'private, max-age=300',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
          },
        })
      } else {
        // Long-lived URL for video streaming — allows browser to seek/scrub via range requests directly on R2
        presignedUrl = await s3GetPresignedStreamUrl(filePath, 14400, contentType)
      }

      // Record analytics for S3 downloads (presigned redirect — cannot track transfer progress)
      if (isDownload && !isAdminRequest && !isProbe && securitySettings.trackAnalytics) {
         
        const v = video!
        await prisma.videoAnalytics.create({
          data: {
            videoId: v.id,
            projectId: v.projectId,
            eventType: 'DOWNLOAD_SUCCEEDED',
            assetId: assetId || undefined,
            ipAddress: getClientIpAddress(request) || undefined,
            sessionId,
            details: { source: 'S3' },
          },
        }).catch(() => undefined)
      }

      return NextResponse.redirect(presignedUrl, {
        status: 302,
        headers: {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      })
    }

    let fullPath = getFilePath(filePath)
    if (!existsSync(fullPath)) {
      // No canonical fallback — StoredFile is the canonical path now
      return NextResponse.json({ error: 'Access denied' }, { status: 404 })
    }
    if (!existsSync(fullPath)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 404 })
    }

    const stat = statSync(fullPath)

    const range = request.headers.get('range')
    const { downloadChunkSizeBytes } = await getTransferTuningSettings()

    // Timeline sprites/VTT and thumbnails are token-gated, non-sensitive derived
    // preview files. Allow the browser to cache them privately so preloading and
    // repeated hover scrubbing reuse the bytes instead of re-fetching (which
    // caused brief black frames when crossing into a not-yet-loaded sprite sheet).
    // `private` keeps them out of shared/CDN caches; the access token lives in the
    // URL, so a rotated token is a fresh URL requiring fresh authorization.
    const cacheControl = isProbe
      ? 'private, no-store, must-revalidate'
      : (isThumbnail || isTimelineAsset)
      ? 'private, max-age=3600'
      : 'public, max-age=3600'

    if (isDownload) {
      // Use asset filename if available, otherwise generate from video info
       
      const v = video!
      const rawFilename = filename
        || `${v.project.title.replace(/[^a-z0-9]/gi, '_')}_${verifiedToken.quality}.mp4`
      const sanitizedFilename = sanitizeFilenameForHeader(rawFilename)

      // For non-asset streams, determine Content-Type based on quality
      if (!assetId) {
        contentType = isThumbnail ? 'image/jpeg' : (isTimelineAsset ? contentType : 'video/mp4')
      }

      const shouldTrackDownload = Boolean(downloadId && !isAdminRequest && !isProbe)

      if (shouldTrackDownload) {
        // Fire-and-forget: registering the download in Redis must not delay
        // the response start. The tracking record is seeded with the file size
        // and current timestamp; progress is updated during streaming.
         
        const v = video!
        void registerTrackedDownload({
          downloadId: downloadId!,
          projectId: verifiedToken.projectId,
          videoId: verifiedToken.videoId,
          videoName: v.name,
          versionLabel: v.versionLabel || null,
          assetId: assetId || null,
          fileSizeBytes: stat.size,
          sessionId,
          ipAddress: getClientIpAddress(request) || null,
        }).catch(() => undefined)
      }

      const createDownloadTrackingHooks = (rangeStart: number) => {
        if (!shouldTrackDownload || !downloadId) {
          return undefined
        }

        let bytesSent = 0
        let flushed = false
        const flush = () => {
          if (flushed) return
          flushed = true
          if (bytesSent <= 0) return
          void recordTrackedDownloadProgress({
            downloadId,
            rangeStart,
            bytesSent,
          }).catch(() => undefined)
        }

        return {
          onBytes: (bytes: number) => {
            bytesSent += bytes
          },
          onComplete: flush,
          onError: flush,
          onCancel: flush,
        }
      }

      // If no Range header, stream entire file with 200 so downloads aren't truncated
      if (!range) {
        const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })
        const readableStream = createWebReadableStream(fileStream, createDownloadTrackingHooks(0))

        return new NextResponse(readableStream, {
          headers: {
            'Content-Type': contentType,
            'Content-Length': stat.size.toString(),
            'Accept-Ranges': 'bytes',
            'Content-Disposition': `attachment; filename="${sanitizedFilename}"`,
            'Cache-Control': 'private, no-cache',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
          },
        })
      }

      // If client requested range, serve in 16MB chunks to keep UI responsive
      const rawRange = range || 'bytes=0-'
      const parts = rawRange.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const requestedEnd = parts[1] ? parseInt(parts[1], 10) : start + downloadChunkSizeBytes - 1
      const end = Math.min(requestedEnd, start + downloadChunkSizeBytes - 1, stat.size - 1)
      const chunksize = (end - start) + 1

      const fileStream = createReadStream(fullPath, { start, end, highWaterMark: downloadChunkSizeBytes })
      const readableStream = createWebReadableStream(fileStream, createDownloadTrackingHooks(start))

      return new NextResponse(readableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize.toString(),
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${sanitizedFilename}"`,
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      })
    }

    if (isAssetPlaybackPreview) {
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)
        const requestedEnd = parts[1] ? parseInt(parts[1], 10) : start + downloadChunkSizeBytes - 1
        const cappedEnd = isProbe
          ? requestedEnd
          : Math.min(requestedEnd, start + downloadChunkSizeBytes - 1)
        const end = Math.min(cappedEnd, stat.size - 1)
        const chunksize = (end - start) + 1

        const fileStream = createReadStream(fullPath, { start, end, highWaterMark: downloadChunkSizeBytes })
        const readableStream = createWebReadableStream(fileStream)

        return new NextResponse(readableStream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize.toString(),
            'Content-Type': contentType,
            'Cache-Control': 'private, no-cache',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'CF-Cache-Status': 'DYNAMIC',
          },
        })
      }

      const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })
      const readableStream = createWebReadableStream(fileStream)

      return new NextResponse(readableStream, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': stat.size.toString(),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'CF-Cache-Status': 'DYNAMIC',
        },
      })
    }

    if (isAssetPreview) {
      const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })
      const readableStream = createWebReadableStream(fileStream)

      return new NextResponse(readableStream, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': stat.size.toString(),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'CF-Cache-Status': 'DYNAMIC',
        },
      })
    }

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const requestedEnd = parts[1] ? parseInt(parts[1], 10) : start + downloadChunkSizeBytes - 1
      const cappedEnd = isProbe
        ? requestedEnd
        : Math.min(requestedEnd, start + downloadChunkSizeBytes - 1)
      // Cap normal streaming chunk size so scrubbing doesn't request the entire remainder of the file.
      // Probe requests are allowed to read the full requested range for connection testing.
      const end = Math.min(cappedEnd, stat.size - 1)
      const chunksize = (end - start) + 1

      const fileStream = createReadStream(fullPath, { start, end, highWaterMark: downloadChunkSizeBytes })
      const readableStream = createWebReadableStream(fileStream)

      // For non-asset streams, determine Content-Type based on quality
      if (!assetId) {
        contentType = isThumbnail ? 'image/jpeg' : (isTimelineAsset ? contentType : 'video/mp4')
      }

      return new NextResponse(readableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize.toString(),
          'Content-Type': contentType,
          'Cache-Control': cacheControl,
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'CF-Cache-Status': 'DYNAMIC',
        },
      })
    }

    const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })
    const readableStream = createWebReadableStream(fileStream)

    // For non-asset streams, determine Content-Type based on quality
    if (!assetId) {
      contentType = isThumbnail ? 'image/jpeg' : 'video/mp4'
    }

    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': stat.size.toString(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'CF-Cache-Status': 'DYNAMIC',
      },
    })
  } catch (error) {
    // Stream errors are technical issues, not security events
    console.error('[STREAM] Video streaming error:', error)

    return NextResponse.json({ error: 'Failed to stream video' }, { status: 500 })
  }
}
