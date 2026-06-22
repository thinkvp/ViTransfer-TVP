import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isSmtpConfigured, getRateLimitSettings, getShareTokenTtlSeconds } from '@/lib/settings'
import { getCurrentUserFromRequest, getShareContext, signShareToken, parseBearerToken } from '@/lib/auth'
import { getPrimaryRecipient, getProjectRecipients } from '@/lib/recipients'
import { verifyProjectAccess, fetchProjectWithVideos } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { trackSharePageAccess } from '@/lib/share-access-tracking'
import { touchProjectLastAccessForRequest } from '@/lib/project-last-access'
import { getRedis } from '@/lib/redis'
import { getClientIpAddress } from '@/lib/utils'
import crypto from 'crypto'
import { getStoredFileRecords } from '@/lib/stored-file'
import { generateVideoAccessToken } from '@/lib/video-access'
import { isS3Mode, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
export const runtime = 'nodejs'




export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const { ipRateLimit } = await getRateLimitSettings()
    const shareTtlSeconds = await getShareTokenTtlSeconds()

    const rateLimitResult = await rateLimit(request, {
      windowMs: 15 * 60 * 1000,
      maxRequests: ipRateLimit || 100,
      message: 'Too many requests. Please try again later.'
    }, `share-access:${token}`)
    if (rateLimitResult) return rateLimitResult

    const projectMeta = await prisma.project.findUnique({
      where: { slug: token },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
      },
    })

    if (!projectMeta) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const shareContext = await getShareContext(request)

    // SECURITY: If user sent a bearer token but it failed verification (revoked, expired, invalid),
    // handle based on current authMode:
    // - NONE auth: Ignore invalid token, proceed as if no token sent
    // - PASSWORD/OTP/BOTH: Return 401 to force re-authentication
    const bearerToken = parseBearerToken(request)
    if (bearerToken && !shareContext && projectMeta.authMode !== 'NONE') {
      const currentUser = await getCurrentUserFromRequest(request)
      const isInternalUser = !!currentUser

      if (!isInternalUser) {
        // Token was sent but invalid/revoked - force re-authentication
        return NextResponse.json({
          error: 'Session expired or invalid. Please authenticate again.',
          requiresPassword: true,
          authMode: projectMeta.authMode || 'PASSWORD'
        }, { status: 401 })
      }
    }

    const project = await fetchProjectWithVideos(
      token,
      projectMeta.id
    )

    if (!project) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const accessCheck = await verifyProjectAccess(
      request,
      projectMeta.id,
      projectMeta.sharePassword,
      projectMeta.authMode,
      { allowAnonymousNone: true }
    )

    if (!accessCheck.authorized) {
      if (accessCheck.errorResponse?.status === 403) {
        const response = accessCheck.errorResponse
        response.headers.set('Cache-Control', 'no-store')
        response.headers.set('Pragma', 'no-cache')
        return response
      }

      return NextResponse.json(
        {
          error: 'Authentication required',
          requiresPassword: true,
          authMode: projectMeta.authMode || 'PASSWORD',
        },
        {
          status: 401,
          headers: {
            'Cache-Control': 'no-store',
            'Pragma': 'no-cache',
          },
        }
      )
    }

    const { isAdmin } = accessCheck

    if (!isAdmin && shareContext?.accessMethod) {
      await touchProjectLastAccessForRequest({
        projectId: projectMeta.id,
        request,
        sessionId: shareContext.sessionId,
      }).catch(() => {})
    }

    // Track share page access for projects with no authentication (authMode = NONE)
    if (projectMeta.authMode === 'NONE' && !isAdmin) {
      // Use Redis for 30-minute deduplication
      const redis = getRedis()
      const ipAddress = getClientIpAddress(request)
      const dedupeKey = `share_access:${projectMeta.id}:${ipAddress}`
      const alreadyTracked = await redis.get(dedupeKey)

      if (!alreadyTracked) {
        // CRITICAL: Use deterministic sessionId for NONE authMode
        // This must match the sessionId used in JWT token for session invalidation to work
        const sessionId = `none:${projectMeta.id}:${ipAddress}`

        await trackSharePageAccess({
          projectId: projectMeta.id,
          accessMethod: 'NONE',
          sessionId,
          request,
        })

        // Set 30-minute deduplication window
        await redis.set(dedupeKey, '1', 'EX', 30 * 60)
      }
    }


    // Resolve preview availability and original file sizes from StoredFile
    const videoIds = project.videos.map((v: any) => v.id)
    const storedPreviews = videoIds.length > 0 ? await getStoredFileRecords('VIDEO', videoIds, { fileRoles: ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL', 'ORIGINAL'], select: { entityId: true, fileRole: true, fileSize: true, fileName: true, storagePath: true } }) : []

    const previewMap = new Map<string, Set<string>>()
    const sizeMap = new Map<string, number>()
    const nameMap = new Map<string, string>()
    const thumbPathByVideoId = new Map<string, string>()
    for (const s of storedPreviews) {
      if (!previewMap.has(s.entityId)) previewMap.set(s.entityId, new Set())
      previewMap.get(s.entityId)!.add(s.fileRole)
      if (s.fileRole === 'ORIGINAL') {
        if (s.fileSize != null) sizeMap.set(s.entityId, Number(s.fileSize))
        if (s.fileName) nameMap.set(s.entityId, s.fileName)
      }
      if (s.fileRole === 'THUMBNAIL' && s.storagePath) {
        thumbPathByVideoId.set(s.entityId, s.storagePath)
      }
    }

    // Mint thumbnail access tokens inline so the client can render preview tiles
    // immediately, without a per-video /video-token round-trip before each image.
    // Tokens are session-bound and cached per session (see generateVideoAccessToken),
    // so re-loading the payload within a session reuses the same token — no proliferation.
    // Skipped entirely when videos are disabled for the project.
    const thumbnailSessionId = shareContext?.sessionId || `share:${projectMeta.id}:${token}`
    const thumbnailUrlByVideoId = new Map<string, string>()
    if (project.enableVideos !== false) {
      const videosWithThumb = project.videos.filter((v: any) => previewMap.get(v.id)?.has('THUMBNAIL'))
      const s3 = isS3Mode()
      await Promise.all(
        videosWithThumb.map(async (v: any) => {
          // S3 mode: presign the thumbnail directly so the client renders preview tiles
          // straight from R2, with no /api/content round-trip + 302 redirect per video.
          if (s3) {
            const thumbPath = thumbPathByVideoId.get(v.id)
            if (thumbPath) {
              try {
                thumbnailUrlByVideoId.set(v.id, await s3GetPresignedStreamUrl(thumbPath, 14400, 'image/jpeg'))
                return
              } catch (error) {
                console.error('[SHARE] Failed to presign thumbnail URL', { videoId: v.id, error })
                // Fall through to token minting.
              }
            }
          }
          try {
            const thumbToken = await generateVideoAccessToken(v.id, projectMeta.id, 'thumbnail', request, thumbnailSessionId)
            if (thumbToken) thumbnailUrlByVideoId.set(v.id, `/api/content/${thumbToken}`)
          } catch (error) {
            console.error('[SHARE] Failed to mint thumbnail token', { videoId: v.id, error })
          }
        }),
      )
    }

    const videosSanitizedBase = project.videos.map((video: any) => {
      const previews = previewMap.get(video.id) ?? new Set<string>()
      const hasOriginal = previews.has('ORIGINAL')
      const hasThumb = previews.has('THUMBNAIL')
      return {
        ...video,
        originalFileSize: String(sizeMap.get(video.id) ?? 0),
        streamUrl480p: '',
        streamUrl720p: '',
        streamUrl1080p: '',
        downloadUrl: null,
        thumbnailUrl: thumbnailUrlByVideoId.get(video.id) ?? null,
        hasThumbnail: hasThumb,
        thumbnailPath: hasThumb,       // used as boolean by admin share page
        preview480Path: previews.has('PREVIEW_480'),
        preview720Path: previews.has('PREVIEW_720'),
        preview1080Path: previews.has('PREVIEW_1080'),
        originalStoragePath: hasOriginal, // used as boolean by admin share page
        originalFileName: hasOriginal ? (nameMap.get(video.id) ?? undefined) : undefined,
        timelinePreviewVttPath: undefined,
        timelinePreviewSpritesPath: undefined,
      }
    })

    const videosByName = videosSanitizedBase.reduce((acc: any, video: any) => {
      const name = video.name
      if (!acc[name]) {
        acc[name] = []
      }
      acc[name].push(video)
      return acc
    }, {})

    Object.keys(videosByName).forEach(name => {
      videosByName[name].sort((a: any, b: any) => b.version - a.version)
    })

    const sortedVideosByName: Record<string, any[]> = {}
    const sortedKeys = Object.keys(videosByName).sort((nameA, nameB) =>
      nameA.localeCompare(nameB, undefined, { sensitivity: 'base' })
    )

    sortedKeys.forEach((key) => {
      sortedVideosByName[key] = videosByName[key]
    })

    // Parallelize independent queries for better performance
    const [smtpConfigured, globalSettings, primaryRecipient] = await Promise.all([
      isSmtpConfigured(),
      prisma.settings.findUnique({
        where: { id: 'default' },
        select: {
          companyName: true,
          defaultPreviewResolutions: true,
          companyLogoMode: true,
          companyLogoUrl: true,
          mainCompanyDomain: true,
        },
      }),
      getPrimaryRecipient(project.id)
    ])

    let allRecipients: Array<{ id: string; name: string | null; email: string | null; displayColor?: string | null }> = []
    {
      const recipients = await getProjectRecipients(project.id)
      allRecipients = recipients
        .filter(r => r.id)
        .map(r => ({
          id: r.id!,
          name: r.name,
          email: r.email || null,
          displayColor: (r as any).displayColor ?? null,
        }))
    }

    const effectiveVideos = project.enableVideos === false ? [] : videosSanitizedBase
    const effectiveVideosByName = project.enableVideos === false ? {} : sortedVideosByName

    const projectData = {
      id: project.id,

      title: project.title,

      status: project.status,

      enableVideos: project.enableVideos ?? true,
      enablePhotos: project.enablePhotos ?? false,
      enableUploads: project.enableUploads ?? true,

      clientName: project.companyName || primaryRecipient?.name || 'Client',
      clientEmail: primaryRecipient?.email || null,
      companyName: project.companyName || null,
      recipients: allRecipients,

      enableRevisions: project.enableRevisions,
      maxRevisions: project.maxRevisions,
      restrictCommentsToLatestVersion: project.restrictCommentsToLatestVersion,
      hideFeedback: project.hideFeedback || project.status === 'SHARE_ONLY',
      useFullTimecode: (project as any).useFullTimecode ?? false,
      allowClientDeleteComments: project.allowClientDeleteComments,
      enableClientUploads: project.enableClientUploads ?? true,
      allowClientUploadFiles: project.allowClientUploadFiles,
      previewResolutions: project.previewResolutions,
      watermarkEnabled: project.watermarkEnabled,

      timelinePreviewsEnabled: project.timelinePreviewsEnabled,

      videos: effectiveVideos,
      videosByName: effectiveVideosByName,

      smtpConfigured,

      settings: {
        companyName: globalSettings?.companyName || 'Studio',
        defaultPreviewResolutions: globalSettings?.defaultPreviewResolutions || '["720p"]',
        hasLogo: globalSettings?.companyLogoMode === 'UPLOAD'
          ? true // StoredFile handles logo paths
          : globalSettings?.companyLogoMode === 'LINK'
            ? Boolean(globalSettings.companyLogoUrl)
            : false,
        mainCompanyDomain: globalSettings?.mainCompanyDomain || null,
      },
    }

    const responseBody: any = projectData

    // Issue or renew a share token.
    // Non-admin visitors always receive a fresh token so the session rolls forward
    // during long uploads and downloads (the keepalive calls this endpoint every
    // 5 min while hasAnyActiveTransfers is true).
    // Admin sessions receive a share token only on first access; their lifecycle
    // is managed by the admin JWT, not by this token.
    if (!shareContext || !isAdmin) {
      // For renewals preserve the original session claims so revocation still works.
      // For first-time visitors derive sessionId from the access check or authMode.
      let sessionId: string
      if (shareContext?.sessionId) {
        sessionId = shareContext.sessionId
      } else if (projectMeta.authMode === 'NONE') {
        // CRITICAL: For NONE authMode, use deterministic sessionId based on IP
        // This must match the sessionId used in SharePageAccess tracking
        const ipAddress = getClientIpAddress(request)
        sessionId = `none:${projectMeta.id}:${ipAddress}`
      } else {
        sessionId = accessCheck.shareTokenSessionId || `share:${project.id}:${token}`
      }

      const shareToken = signShareToken({
        shareId: token,
        projectId: project.id,
        permissions: ['view', 'comment', 'download'],
        guest: false,
        sessionId,
        authMode: shareContext?.authMode ?? projectMeta.authMode,
        accessMethod: shareContext?.accessMethod ?? (projectMeta.authMode === 'NONE' ? 'NONE' : undefined),
        ttlSeconds: shareTtlSeconds,
      })
      responseBody.shareToken = shareToken
    }

    const response = NextResponse.json(responseBody)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    return NextResponse.json({
      error: 'Unable to process request'
    }, { status: 500 })
  }
}
