import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isSmtpConfigured, sendProjectApprovedEmail, sendAdminProjectApprovedEmail } from '@/lib/email'
import { handleApprovalNotification } from '@/lib/notifications'
import { getSecuritySettings } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { getProjectRecipients, getPrimaryRecipient } from '@/lib/recipients'
import { generateShareUrl } from '@/lib/url'
import { getAutoApproveProject } from '@/lib/settings'
import { verifyProjectAccess } from '@/lib/project-access'
import { getCurrentUserFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { publishProjectEvent } from '@/lib/project-events'
import { z } from 'zod'
export const runtime = 'nodejs'




const approveSchema = z.object({
  authorName: z.string().trim().max(100, 'Name too long').optional().nullable(),
  authorEmail: z.string().email().max(255, 'Email too long').optional().nullable(),
  selectedVideoId: z.string().min(1, 'Selected video is required'),
  recipientId: z.string().trim().max(64).optional().nullable(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Rate limiting: 20 approval actions per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many approval requests. Please slow down.'
  }, 'project-approve')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id: projectId } = await params
    const body = await request.json()
    const parsed = approveSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
    }

    const { authorName, authorEmail, selectedVideoId, recipientId } = parsed.data

    console.log('[APPROVAL] Starting approval process for project:', projectId)
    console.log('[APPROVAL] Selected video:', selectedVideoId)

    // SECURITY: Validate share password if project is password-protected
    // This allows clients to approve their own projects via the share link
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        videos: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Verify project access using dual auth pattern (clients can approve via share link)
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)

    if (!accessCheck.authorized) {
      return NextResponse.json({
        error: 'Password required to approve this project'
      }, { status: 401 })
    }

    if (project.status === 'APPROVED') {
      return NextResponse.json({ error: 'Project already approved' }, { status: 400 })
    }

    // Find the selected video
    const selectedVideo = project.videos.find(v => v.id === selectedVideoId)

    if (!selectedVideo) {
      return NextResponse.json({ error: 'Selected video not found' }, { status: 404 })
    }

    if ((selectedVideo as any).allowApproval === false) {
      return NextResponse.json({ error: 'Approval is disabled for this video version' }, { status: 403 })
    }

    // Idempotency guard: if this exact video is already approved, return success without
    // re-sending notifications. Prevents duplicate admin/client emails when the approve
    // endpoint is called more than once for the same video (e.g. retry, double-click, or
    // simultaneous sessions).
    if ((selectedVideo as any).approved === true) {
      console.log(`[APPROVAL] Video ${selectedVideoId} is already approved — skipping duplicate notification`)
      return NextResponse.json({ message: 'Video already approved' })
    }

    // Resolve who is approving, for activity-feed attribution.
    // Admin session → admin identity; otherwise the recipient picked on the share page
    // (validated against this project) or the recipient embedded in the OTP share token,
    // falling back to the free-text authorName.
    let approvedById: string | null = null
    let approvedByRecipientId: string | null = null
    let approvedByName: string | null = null
    if (accessCheck.isAdmin) {
      approvedById = accessCheck.adminUserId || null
      approvedByName = accessCheck.adminUserName || 'Admin'
    } else {
      const candidateRecipientId = (recipientId && recipientId.trim()) || accessCheck.shareRecipientId || null
      if (candidateRecipientId) {
        const recipient = await prisma.projectRecipient.findFirst({
          where: { id: candidateRecipientId, projectId },
          select: { id: true, name: true },
        })
        if (recipient) {
          approvedByRecipientId = recipient.id
          approvedByName = recipient.name || null
        }
      }
      if (!approvedByName) approvedByName = (authorName && authorName.trim()) || 'Client'
    }

    // IMPORTANT: When approving a video, unapprove all other versions of the SAME video
    // This ensures only ONE version per video name can be approved at a time
    const now = new Date()
    await prisma.video.updateMany({
      where: {
        projectId,
        name: selectedVideo.name, // Same video name
        id: { not: selectedVideoId }, // But different version
        approved: true,
      },
      data: {
        approved: false,
        approvedAt: null,
        unapprovedAt: now,
        unapprovedById: approvedById,
        unapprovedByRecipientId: approvedByRecipientId,
        unapprovedByName: approvedByName,
      },
    })

    // Now approve the selected video
    await prisma.video.update({
      where: { id: selectedVideoId },
      data: {
        approved: true,
        approvedAt: now,
        approvedById,
        approvedByRecipientId,
        approvedByName,
      },
    })

    try {
      const settings = await getSecuritySettings()
      if (settings.trackAnalytics) {
        await prisma.videoAnalytics.create({
          data: {
            videoId: selectedVideoId,
            projectId,
            eventType: 'VIDEO_APPROVED',
            sessionId: accessCheck.shareTokenSessionId || null,
            ipAddress: getClientIpAddress(request) || null,
          },
        })
      }
    } catch (error) {
      console.warn('[APPROVAL] Failed to log video approval analytics:', error)
    }

    // Check if all UNIQUE videos have at least one approved version
    const allVideos = await prisma.video.findMany({
      where: { projectId },
      select: { id: true, approved: true, name: true },
    })

    // Group videos by name to get unique videos
    const videosByName = allVideos.reduce((acc: Record<string, any[]>, video) => {
      if (!acc[video.name]) {
        acc[video.name] = []
      }
      acc[video.name].push(video)
      return acc
    }, {})

    // Check if each unique video has at least one approved version
    const allApproved = Object.values(videosByName).every((versions: any[]) =>
      versions.some(v => v.approved)
    )

    // Check if auto-approve is enabled
    const autoApprove = await getAutoApproveProject()

    // If all unique videos are approved AND auto-approve enabled, approve the project
    if (allApproved && autoApprove) {
      const previousStatus = project.status
      await prisma.project.update({
        where: { id: projectId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedVideoId: selectedVideoId, // Keep for backward compatibility
        },
      })

      await prisma.projectStatusChange.create({
        data: {
          projectId,
          previousStatus,
          currentStatus: 'APPROVED',
          source: 'CLIENT',
          changedById: null,
        },
      })

      // NOTE: Approval notifications are always sent immediately (see email sending code below)
      // They are NOT queued because approvals should notify clients right away
    } else {
      // Partial review/approval action by client: mark the project as Reviewed
      if (!accessCheck.isAdmin && project.status !== 'REVIEWED') {
        const previousStatus = project.status
        await prisma.project.update({
          where: { id: projectId },
          data: { status: 'REVIEWED' },
        })

        await prisma.projectStatusChange.create({
          data: {
            projectId,
            previousStatus,
            currentStatus: 'REVIEWED',
            source: 'CLIENT',
            changedById: null,
          },
        })
      }
    }

    console.log('[APPROVAL] Video approval complete, preparing notifications')

    // Handle approval notifications (will queue and/or send immediately based on schedule)
    try {
      const smtpConfigured = await isSmtpConfigured()
      console.log('[APPROVAL] SMTP configured:', smtpConfigured)

      if (!smtpConfigured) {
        console.log('[APPROVAL] SMTP not configured, skipping notifications')
      } else {
        // Get all approved videos for multi-video support
        const approvedVideos = allVideos.filter(v => v.approved)
        const approvedVideosList = approvedVideos.map(v => ({
          name: v.name,
          id: v.id
        }))

        // Determine if this is a complete project approval or partial
        // Complete = ALL unique videos have at least one approved version
        const isCompleteProjectApproval = allApproved && autoApprove

        // Use new unified notification system
        // Resolve author name: use provided name, or if admin session, look up from auth
        let safeAuthorName: string | undefined = authorName || undefined
        let safeAuthorEmail: string | undefined = authorEmail || undefined
        if (!safeAuthorName && accessCheck.isAdmin) {
          const adminUser = await getCurrentUserFromRequest(request)
          safeAuthorName = adminUser?.name || undefined
          if (!safeAuthorEmail) {
            safeAuthorEmail = adminUser?.email || undefined
          }
        }

        await handleApprovalNotification({
          project: {
            id: project.id,
            title: project.title,
            slug: project.slug,
            clientNotificationSchedule: project.clientNotificationSchedule
          },
          video: {
            id: selectedVideoId,
            name: selectedVideo.name,
            versionLabel: (selectedVideo as any).versionLabel ?? null,
          },
          approvedVideos: approvedVideosList,
          approved: true,
          authorName: safeAuthorName,
          authorEmail: safeAuthorEmail,
          isComplete: isCompleteProjectApproval, // Pass whether ALL videos are approved
          performedByAdmin: accessCheck.isAdmin,
        })
      }
    } catch (error) {
      console.error('[APPROVAL] Error handling approval notifications:', error)
    }

    // Notify any open share pages / admin dashboards so the approval badge and
    // (auto-approve / Reviewed) status update live for everyone viewing.
    await publishProjectEvent(projectId, 'approval')

    console.log('[APPROVAL] Approval process complete, returning success')
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[APPROVAL] ERROR in approval route:', error)
    return NextResponse.json({ error: 'Failed to approve project' }, { status: 500 })
  }
}
