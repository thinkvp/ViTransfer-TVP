import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getSecuritySettings } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { z } from 'zod'
export const runtime = 'nodejs'




const unapproveSchema = z.object({
  unapproveVideos: z.boolean().optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectStatuses')
  if (forbiddenAction) return forbiddenAction

  const admin = authResult

  // Rate limiting: 20 unapproval actions per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many requests. Please slow down.'
  }, 'admin-unapprove')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id: projectId } = await params

    // Parse request body to get unapprove options
    const body = await request.json().catch(() => ({}))
    const parsed = unapproveSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const { unapproveVideos = true } = parsed.data // Default to true for backward compatibility

    // Get project details
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        videos: {
          select: { id: true, approved: true, name: true, versionLabel: true }
        }
      }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    let unapprovedCount = 0

    const approvedVideos = project.videos.filter(v => v.approved)

    // Conditionally unapprove videos based on the parameter
    if (unapproveVideos) {
      // Unapprove ALL videos in the project
      await prisma.video.updateMany({
        where: { projectId },
        data: {
          approved: false,
          approvedAt: null
        }
      })

      unapprovedCount = approvedVideos.length

      try {
        const settings = await getSecuritySettings()
        if (settings.trackAnalytics && approvedVideos.length > 0) {
          const ipAddress = getClientIpAddress(request) || null
          await prisma.videoAnalytics.createMany({
            data: approvedVideos.map(video => ({
              videoId: video.id,
              projectId,
              eventType: 'VIDEO_UNAPPROVED',
              sessionId: `admin:${admin.id}`,
              ipAddress,
            }))
          })
        }
      } catch (error) {
        console.warn('[APPROVAL] Failed to log video unapproval analytics:', error)
      }
    }

    // Always unapprove the project
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: 'IN_REVIEW',
        approvedAt: null,
        approvedVideoId: null
      }
    })

    if (project.status !== 'IN_REVIEW') {
      await prisma.projectStatusChange.create({
        data: {
          projectId,
          previousStatus: project.status as any,
          currentStatus: 'IN_REVIEW' as any,
          source: 'ADMIN',
          changedById: admin.id,
        },
      })
    }

    return NextResponse.json({
      success: true,
      unapprovedCount,
      unapprovedVideos: unapproveVideos
    })
  } catch (error) {
    console.error('Error unapproving project:', error)
    return NextResponse.json(
      { error: 'Failed to unapprove project' },
      { status: 500 }
    )
  }
}
