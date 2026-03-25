import { NextRequest, NextResponse } from 'next/server'
import { verifyVideoAccessToken, detectHotlinking, logSecurityEvent, getSecuritySettings } from '@/lib/video-access'
import { getRedis } from '@/lib/redis'
import { prisma } from '@/lib/db'
import { createReadStream, existsSync, statSync, ReadStream } from 'fs'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { DropboxPreferredDownloadError, resolveStorageDownloadTarget } from '@/lib/storage-provider'
import {
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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type WithOptionalDropboxPath = {
  dropboxPath?: string | null
}

function buildCanonicalFallbackPath(params: {
  video: any
  quality: string
  asset?: { fileName: string } | null
  spriteFile?: string | null
}): string | null {
  const { video, quality, asset, spriteFile } = params
  const projectStoragePath = video?.project?.storagePath
  const videoFolderName = video?.storageFolderName || video?.name
  const versionLabel = video?.versionLabel

  if (!projectStoragePath || !videoFolderName || !versionLabel) return null

  if (asset?.fileName) {
    return buildVideoAssetStoragePath(projectStoragePath, videoFolderName, versionLabel, asset.fileName)
  }

  switch (quality) {
    case 'thumbnail':
      return buildVideoThumbnailStoragePath(projectStoragePath, videoFolderName, versionLabel)
    case 'timeline-vtt':
      return `${buildVideoTimelineStorageRoot(projectStoragePath, videoFolderName, versionLabel)}/index.vtt`
    case 'timeline-sprite':
      return spriteFile
        ? `${buildVideoTimelineStorageRoot(projectStoragePath, videoFolderName, versionLabel)}/${spriteFile}`
        : null
    case '480p':
    case '720p':
    case '1080p':
      return buildVideoPreviewStoragePath(projectStoragePath, videoFolderName, versionLabel, quality)
    case 'original':
    case 'download':
      return video?.originalFileName
        ? buildVideoOriginalStoragePath(projectStoragePath, videoFolderName, versionLabel, video.originalFileName)
        : null
    default:
      return null
  }
}

function isValidMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(trimmed)
}

/**
 * Convert Node.js ReadStream to Web ReadableStream with proper backpressure.
 *
 * The previous push-based implementation fired controller.enqueue() as fast as
 * the disk could read, never pausing the Node.js stream. For a 1 GB file on a
 * slow client connection the Web ReadableStream internal queue would grow
 * unbounded in memory, causing OOM errors or HTTP-layer timeouts that forced
 * the client to retry the download from scratch.
 *
 * This pull-based approach only reads the next chunk from disk when the
 * consumer (browser) is ready for more data, keeping memory flat regardless of
 * file size and transfer speed.
 */
function createWebReadableStream(
  fileStream: ReadStream,
  hooks?: {
    onBytes?: (bytes: number) => void
    onComplete?: () => void
    onError?: (error: Error) => void
    onCancel?: () => void
  },
): ReadableStream {
  let ended = false
  let closed = false

  return new ReadableStream({
    start() {
      // Pause immediately — we only resume inside pull().
      fileStream.pause()
      fileStream.once('end', () => { ended = true })
    },

    pull(controller) {
      // Guard: the runtime may call pull() one extra time after the controller
      // was already closed by a previous onEnd/onError callback, which would
      // throw ERR_INVALID_STATE ("Controller is already closed").
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
          const output = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          if (!closed) {
            hooks?.onBytes?.(output.byteLength)
            controller.enqueue(output)
          }
          resolve()
        }
        const onEnd = () => {
          cleanup()
          ended = true
          if (!closed) {
            closed = true
            hooks?.onComplete?.()
            controller.close()
          }
          resolve()
        }
        const onError = (err: Error) => {
          cleanup()
          if (!closed) {
            closed = true
            hooks?.onError?.(err)
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
      if (!closed && !ended) {
        hooks?.onCancel?.()
      }
      closed = true
      fileStream.destroy()
    },
  })
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
    const rawDownloadId = searchParams.get('downloadId')
    const downloadId = rawDownloadId && rawDownloadId.trim().length > 0 ? rawDownloadId.trim() : null

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

    const video = await prisma.video.findUnique({
      where: { id: verifiedToken.videoId },
      include: { project: true },
    })

    if (!video || video.projectId !== verifiedToken.projectId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 404 })
    }

    const originalPath = video.originalStoragePath
    let filePath: string | null = null
    let filename: string | null = null
    let contentType = 'video/mp4'
    let activeDropboxPath: string | null = null
    let selectedAsset: { fileName: string } | null = null
    const canServeOriginal = Boolean(originalPath && (isAdminRequest || video.approved))

    // Handle asset download
    if (assetId && isDownload) {
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

      filePath = asset.storagePath
      filename = asset.fileName
      selectedAsset = { fileName: asset.fileName }
      contentType = isValidMimeType(asset.fileType)
        ? asset.fileType
        : 'application/octet-stream'
      activeDropboxPath = (asset as WithOptionalDropboxPath).dropboxPath ?? null
    } else {
      // Handle video download/stream
      if (verifiedToken.quality === 'thumbnail') {
        filePath = video.thumbnailPath
      } else if (verifiedToken.quality === 'timeline-vtt') {
        if (!video.project.timelinePreviewsEnabled || !video.timelinePreviewsReady) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 })
        }

        filePath = (video as any).timelinePreviewVttPath
        contentType = 'text/vtt'
      } else if (verifiedToken.quality === 'timeline-sprite') {
        if (!video.project.timelinePreviewsEnabled || !video.timelinePreviewsReady) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 })
        }

        const spriteFile = searchParams.get('file')
        if (!spriteFile || !/^sprite-\d{3}\.jpg$/.test(spriteFile)) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 })
        }

        const spritesBasePath = (video as any).timelinePreviewSpritesPath
        if (!spritesBasePath) {
          return NextResponse.json({ error: 'Access denied' }, { status: 404 })
        }

        filePath = `${spritesBasePath}/${spriteFile}`
        contentType = 'image/jpeg'
      } else if (verifiedToken.quality === 'original' || verifiedToken.quality === 'download') {
        if (canServeOriginal) {
          filePath = originalPath
          activeDropboxPath = (video as WithOptionalDropboxPath).dropboxPath ?? null
        }
      } else if (verifiedToken.quality === '1080p') {
        filePath = video.preview1080Path || video.preview720Path || (video as any).preview480Path || (canServeOriginal ? originalPath : null)
      } else if (verifiedToken.quality === '720p') {
        filePath = video.preview720Path || video.preview1080Path || (video as any).preview480Path || (canServeOriginal ? originalPath : null)
      } else if (verifiedToken.quality === '480p') {
        filePath = (video as any).preview480Path || video.preview720Path || video.preview1080Path || (canServeOriginal ? originalPath : null)
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
        : (!isThumbnail && !isTimelineAsset ? 'STREAMING_VIDEO' : null)

      if (activityType) {
        // Fire-and-forget: activity tracking is analytics-only and must not
        // delay the response. Awaiting Redis ops here was adding latency before
        // the first response byte, which caused HAProxy to RST_STREAM on slow
        // Redis round-trips (observed after HAProxy 3.x upgrade).
        void recordClientActivity({
          sessionId,
          projectId: video.projectId,
          projectTitle: video.project.title,
          videoId: video.id,
          videoName: video.name,
          versionLabel: video.versionLabel || null,
          assetId: assetId || null,
          assetName: filename || null,
          activityType,
          ipAddress: getClientIpAddress(request) || null,
          throttleKey: `${sessionId}:${video.id}:${assetId || verifiedToken.quality}:${activityType}`,
          throttleSeconds: 15,
        }).catch(() => undefined)
      }
    }

    if (isDownload && (isThumbnail || isTimelineAsset)) {
      return NextResponse.json({ error: 'Thumbnails cannot be downloaded directly' }, { status: 403 })
    }

    const forceLocal = searchParams.get('forceLocal') === 'true'
    const resolvedTarget = await resolveStorageDownloadTarget(filePath, {
      preferDropbox: isDownload && !forceLocal,
      dropboxPath: activeDropboxPath,
    })
    let effectiveResolvedTarget = resolvedTarget
    if (effectiveResolvedTarget.kind === 'local-file' && !existsSync(effectiveResolvedTarget.absolutePath)) {
      const fallbackPath = buildCanonicalFallbackPath({
        video,
        quality: verifiedToken.quality,
        asset: selectedAsset,
        spriteFile: searchParams.get('file'),
      })

      if (fallbackPath && fallbackPath !== filePath) {
        const fallbackTarget = await resolveStorageDownloadTarget(fallbackPath, {
          preferDropbox: isDownload && !forceLocal,
          dropboxPath: activeDropboxPath,
        })
        if (fallbackTarget.kind === 'local-file' ? existsSync(fallbackTarget.absolutePath) : true) {
          effectiveResolvedTarget = fallbackTarget
          filePath = fallbackPath
        }
      }
    }
    if (effectiveResolvedTarget.kind === 'redirect') {
      // Record analytics event for Dropbox downloads (we can't track transfer progress)
      if (isDownload && !isAdminRequest && !isProbe) {
        const settings = await getSecuritySettings()
        if (settings.trackAnalytics) {
          await prisma.videoAnalytics.create({
            data: {
              videoId: video.id,
              projectId: video.projectId,
              eventType: 'DOWNLOAD_SUCCEEDED',
              assetId: assetId || undefined,
              ipAddress: getClientIpAddress(request) || undefined,
              sessionId,
              details: { source: 'Dropbox' },
            },
          }).catch(() => undefined)
        }
      }

      return NextResponse.redirect(effectiveResolvedTarget.url, {
        status: 307,
        headers: {
          'Cache-Control': 'private, no-store, must-revalidate',
          Pragma: 'no-cache',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      })
    }

    const fullPath = effectiveResolvedTarget.absolutePath
    if (!existsSync(fullPath)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 404 })
    }

    const stat = statSync(fullPath)

    const range = request.headers.get('range')
    const { downloadChunkSizeBytes } = await getTransferTuningSettings()

    const cacheControl = isProbe
      ? 'private, no-store, must-revalidate'
      : (isThumbnail || isTimelineAsset)
      ? 'private, no-store, must-revalidate'
      : 'public, max-age=3600'

    if (isDownload) {
      // Use asset filename if available, otherwise generate from video info
      const rawFilename = filename
        || video.originalFileName
        || `${video.project.title.replace(/[^a-z0-9]/gi, '_')}_${verifiedToken.quality}.mp4`
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
        void registerTrackedDownload({
          downloadId: downloadId!,
          projectId: verifiedToken.projectId,
          videoId: verifiedToken.videoId,
          videoName: video.name,
          versionLabel: video.versionLabel || null,
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
    if (error instanceof DropboxPreferredDownloadError) {
      return NextResponse.json(
        { error: 'Dropbox download is unavailable right now. Retry later or use Force Local if you want to bypass Dropbox.' },
        { status: 502 }
      )
    }
    // Stream errors are technical issues, not security events
    console.error('[STREAM] Video streaming error:', error)

    return NextResponse.json({ error: 'Failed to stream video' }, { status: 500 })
  }
}
