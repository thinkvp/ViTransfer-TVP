import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
export const runtime = 'nodejs'

export const dynamic = 'force-dynamic'

// GET /api/analytics/[id] - Get detailed analytics for a specific project
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'analytics')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'viewAnalytics')
  if (forbiddenAction) return forbiddenAction

  // Rate limiting: 100 requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: 'Too many requests. Please slow down.'
  }, 'admin-analytics-detail')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id } = await params

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        videos: {
          where: { status: 'READY' },
          orderBy: [
            { name: 'asc' },
            { version: 'desc' },
          ],
        },
        recipients: {
          where: { isPrimary: true },
          take: 1,
        },
        sharePageAccesses: {
          orderBy: { createdAt: 'desc' },
        },
        analytics: {
          where: { eventType: { in: ['DOWNLOAD_COMPLETE', 'VIDEO_VIEW', 'VIDEO_PLAY'] } },
          orderBy: { createdAt: 'desc' },
          include: {
            video: {
              select: {
                id: true,
                name: true,
                versionLabel: true,
                originalFileName: true,
                assets: {
                  select: {
                    id: true,
                    fileName: true,
                    category: true,
                  },
                },
              },
            },
          },
        },
        emailEvents: {
          orderBy: { createdAt: 'desc' },
          include: {
            video: {
              select: {
                id: true,
                name: true,
                versionLabel: true,
              },
            },
          },
        },
        emailTracking: {
          where: { openedAt: { not: null } }, // Only include opened emails
          orderBy: { openedAt: 'desc' },
          include: {
            video: {
              select: {
                id: true,
                name: true,
                versionLabel: true,
              },
            },
          },
        },
        statusChanges: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            previousStatus: true,
            currentStatus: true,
            source: true,
            createdAt: true,
            changedBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Group videos by name
    const videosByName = project.videos.reduce((acc, video) => {
      if (!acc[video.name]) {
        acc[video.name] = []
      }
      acc[video.name].push(video)
      return acc
    }, {} as Record<string, typeof project.videos>)

    const downloadAnalytics = project.analytics.filter(a => a.eventType === 'DOWNLOAD_COMPLETE')
    const guestLinkViewAnalytics = project.analytics.filter(a => a.eventType === 'VIDEO_VIEW')
    const sharePlayAnalytics = project.analytics.filter(a => a.eventType === 'VIDEO_PLAY')
    const allViewAnalytics = [...guestLinkViewAnalytics, ...sharePlayAnalytics]

    // Create stats grouped by video name
    const videoStats = Object.entries(videosByName).map(([videoName, versions]) => {
      // Get all video IDs for this video name
      const videoIds = versions.map(v => v.id)

      // Get all analytics for these video IDs
      const videoAnalytics = downloadAnalytics.filter(a => videoIds.includes(a.videoId))
      const totalDownloads = videoAnalytics.length

      const viewsForVideoName = allViewAnalytics.filter(a => videoIds.includes(a.videoId)).length

      // Per-version breakdown
      const versionStats = versions.map(version => {
        const versionAnalytics = downloadAnalytics.filter(a => a.videoId === version.id)
        const versionViews = allViewAnalytics.filter(a => a.videoId === version.id)
        const downloads = versionAnalytics.length
        return {
          id: version.id,
          versionLabel: version.versionLabel,
          views: versionViews.length,
          downloads,
        }
      })

      return {
        videoName,
        totalViews: viewsForVideoName,
        totalDownloads,
        versions: versionStats,
      }
    })

    // Calculate share page access stats
    const uniqueSessions = new Set(project.sharePageAccesses.map(a => a.sessionId)).size

    const accessByMethod = {
      OTP: project.sharePageAccesses.filter(a => a.accessMethod === 'OTP').length,
      PASSWORD: project.sharePageAccesses.filter(a => a.accessMethod === 'PASSWORD').length,
      GUEST: project.sharePageAccesses.filter(a => a.accessMethod === 'GUEST').length,
      NONE: project.sharePageAccesses.filter(a => a.accessMethod === 'NONE').length,
    }

    const totalDownloads = downloadAnalytics.length
    const totalVideoViews = allViewAnalytics.length

    // Combine authentication events and download events into single activity feed
    const authEvents = project.sharePageAccesses.map(access => ({
      id: access.id,
      type: 'AUTH' as const,
      accessMethod: access.accessMethod,
      email: access.email,
      createdAt: access.createdAt,
    }))

    const downloadEvents = downloadAnalytics.map(download => {
      let assetFileName: string | undefined
      let assetFileNames: string[] | undefined

      if (download.assetId) {
        // Single asset download
        const asset = download.video.assets.find(a => a.id === download.assetId)
        assetFileName = asset?.fileName
      } else if (download.assetIds) {
        // Multiple asset download (ZIP)
        const assetIdArray = JSON.parse(download.assetIds) as string[]
        assetFileNames = assetIdArray
          .map(id => download.video.assets.find(a => a.id === id)?.fileName)
          .filter((name): name is string => !!name)
      }

      return {
        id: download.id,
        type: 'DOWNLOAD' as const,
        videoName: download.video.name,
        versionLabel: download.video.versionLabel,
        assetId: download.assetId,
        assetIds: download.assetIds ? JSON.parse(download.assetIds) : undefined,
        assetFileName,
        assetFileNames,
        createdAt: download.createdAt,
      }
    })

    // Keep guest video-link views in Project Activity; share-page plays are not shown here.
    const viewEvents = guestLinkViewAnalytics.map(view => {
      return {
        id: view.id,
        type: 'VIEW' as const,
        videoName: view.video.name,
        versionLabel: view.video.versionLabel,
        createdAt: view.createdAt,
      }
    })

    const emailEvents = project.emailEvents.map(evt => ({
      id: evt.id,
      type: 'EMAIL' as const,
      description: evt.type === 'ALL_READY_VIDEOS'
        ? 'All Ready Videos'
        : evt.type === 'SPECIFIC_ALBUM_READY'
        ? 'Specific Album Ready'
        : evt.type === 'NEW_COMMENT'
        ? 'New Comment'
        : evt.type === 'COMMENT_SUMMARY'
        ? 'Comment Summary'
        : 'Specific Video & Version',
      recipients: JSON.parse(evt.recipientEmails) as string[],
      videoName: evt.video?.name,
      versionLabel: evt.video?.versionLabel,
      createdAt: evt.createdAt,
    }))

    const emailOpenEvents = project.emailTracking.map(tracking => ({
      id: tracking.id,
      type: 'EMAIL_OPEN' as const,
      description: tracking.type === 'ALL_READY_VIDEOS'
        ? 'All Ready Videos'
        : tracking.type === 'SPECIFIC_ALBUM_READY'
        ? 'Specific Album Ready'
        : tracking.type === 'NEW_COMMENT'
        ? 'New Comment'
        : tracking.type === 'COMMENT_SUMMARY'
        ? 'Comment Summary'
        : 'Specific Video & Version',
      recipientEmail: tracking.recipientEmail,
      videoName: tracking.video?.name,
      versionLabel: tracking.video?.versionLabel,
      createdAt: tracking.openedAt!, // Non-null because we filtered for openedAt !== null
    }))

    const statusChangeEvents = project.statusChanges.map((chg) => ({
      id: chg.id,
      type: 'STATUS_CHANGE' as const,
      previousStatus: chg.previousStatus,
      currentStatus: chg.currentStatus,
      source: chg.source,
      changedBy: chg.changedBy
        ? { id: chg.changedBy.id, name: chg.changedBy.name, email: chg.changedBy.email }
        : null,
      createdAt: chg.createdAt,
    }))

    // Merge and sort all activity by timestamp (newest first)
    const allActivity = [...authEvents, ...viewEvents, ...downloadEvents, ...emailEvents, ...emailOpenEvents, ...statusChangeEvents].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )

    const displayName = project.companyName || project.recipients[0]?.name || project.recipients[0]?.email || 'Client'

    return NextResponse.json({
      project: {
        id: project.id,
        title: project.title,
        recipientName: displayName,
        recipientEmail: project.companyName ? null : project.recipients[0]?.email || null,
        status: project.status,
      },
      stats: {
        totalVisits: project.sharePageAccesses.length,
        uniqueVisits: uniqueSessions,
        guestVisits: accessByMethod.GUEST,
        accessByMethod,
        totalDownloads,
        totalVideoViews,
        videoCount: project.videos.length,
      },
      videoStats,
      activity: allActivity,
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Unable to process request' },
      { status: 500 }
    )
  }
}
