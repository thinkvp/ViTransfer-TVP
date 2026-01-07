import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
export const runtime = 'nodejs'

export const dynamic = 'force-dynamic'

// GET /api/analytics - Get analytics for all projects
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // Rate limiting: 100 requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: 'Too many requests. Please slow down.'
  }, 'admin-analytics-list')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const projects = await prisma.project.findMany({
      include: {
        videos: {
          select: {
            id: true,
            status: true,
            name: true,
            approved: true,
          },
        },
        recipients: {
          where: { isPrimary: true },
          take: 1,
        },
        sharePageAccesses: {
          select: {
            accessMethod: true,
            sessionId: true,
          },
        },
        analytics: {
          where: { eventType: 'DOWNLOAD_COMPLETE' },
          select: {
            eventType: true,
          },
        },
        _count: {
          select: {
            comments: true,
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    })

    const projectsWithAnalytics = projects.map(project => {
      const totalDownloads = project.analytics.length
      const displayName = project.companyName || project.recipients[0]?.name || project.recipients[0]?.email || 'Client'

      const readyVideos = project.videos.filter(v => v.status === 'READY')

      // Calculate unique sessions (unique users who accessed the share page)
      const uniqueSessions = new Set(
        project.sharePageAccesses.map(a => a.sessionId)
      ).size

      // Count by access method
      const accessByMethod = {
        OTP: project.sharePageAccesses.filter(a => a.accessMethod === 'OTP').length,
        PASSWORD: project.sharePageAccesses.filter(a => a.accessMethod === 'PASSWORD').length,
        GUEST: project.sharePageAccesses.filter(a => a.accessMethod === 'GUEST').length,
        NONE: project.sharePageAccesses.filter(a => a.accessMethod === 'NONE').length,
      }

      return {
        id: project.id,
        title: project.title,
        recipientName: displayName,
        recipientEmail: project.companyName ? null : project.recipients[0]?.email || null,
        status: project.status,
        videoCount: readyVideos.length,
        videos: project.videos,
        commentsCount: project._count.comments,
        totalVisits: project.sharePageAccesses.length,
        uniqueVisits: uniqueSessions,
        accessByMethod,
        totalDownloads,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      }
    })

    const response = NextResponse.json({ projects: projectsWithAnalytics })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    return NextResponse.json(
      { error: 'Unable to process request' },
      { status: 500 }
    )
  }
}
