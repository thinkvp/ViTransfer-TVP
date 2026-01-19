import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendNewAlbumReadyEmail, sendNewVersionEmail, sendProjectGeneralNotificationEmail, sendPasswordEmail, isSmtpConfigured, getEmailSettings, buildCompanyLogoUrl, sendEmail } from '@/lib/email'
import { generateProjectInviteInternalUsersEmail } from '@/lib/email-templates'
import { generateShareUrl } from '@/lib/url'
import { requireApiAuth } from '@/lib/auth'
import { decrypt } from '@/lib/encryption'
import { getProjectRecipients } from '@/lib/recipients'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions, isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import crypto from 'crypto'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import fs from 'fs'
export const runtime = 'nodejs'



export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authResult = await requireApiAuth(request)
    if (authResult instanceof Response) return authResult

    const forbiddenMenu = requireMenuAccess(authResult, 'projects')
    if (forbiddenMenu) return forbiddenMenu

    const forbiddenAction = requireActionAccess(authResult, 'sendNotificationsToRecipients')
    if (forbiddenAction) return forbiddenAction

    // Throttle to prevent email spam
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 20,
      message: 'Too many notification requests. Please slow down.',
    }, 'project-notify')
    if (rateLimitResult) return rateLimitResult

    // Check if SMTP is configured
    const smtpConfigured = await isSmtpConfigured()
    if (!smtpConfigured) {
      return NextResponse.json(
        { error: 'Email notifications are not available. Please configure SMTP settings in the admin panel.' },
        { status: 400 }
      )
    }

    const { id: projectId } = await params
    const body = await request.json()
    const { videoId, albumId, notifyEntireProject, sendPasswordSeparately, notes, notificationType, internalUserIds, projectFileIds } = body

    const trimmedNotes = typeof notes === 'string' ? notes.trim() : ''

    const isInternalInvite = notificationType === 'internal-invite'

    // Get project details including password
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        title: true,
        slug: true,
        sharePassword: true,
        status: true,
        enablePhotos: true,
        assignedUsers: {
          select: {
            userId: true,
            user: { select: { id: true, email: true, name: true } },
          },
        },
        videos: {
          where: { status: 'READY' },
          select: {
            id: true,
            name: true,
            versionLabel: true,
            status: true,
          },
          orderBy: { createdAt: 'desc' }
        },
        albums: {
          select: {
            id: true,
            name: true,
            _count: { select: { photos: true } },
          },
          orderBy: { name: 'asc' },
        }
      }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // INTERNAL INVITE: send to selected assigned internal users (not to project recipients)
    if (isInternalInvite) {
      const requestedUserIds: string[] = Array.isArray(internalUserIds) ? internalUserIds.map((x: any) => String(x)) : []
      const requestedFileIds: string[] = Array.isArray(projectFileIds) ? projectFileIds.map((x: any) => String(x)) : []

      const uniqueUserIds = Array.from(new Set(requestedUserIds)).filter(Boolean)
      if (uniqueUserIds.length === 0) {
        return NextResponse.json({ error: 'Please select at least one internal user' }, { status: 400 })
      }

      const assignedUserIds = new Set((project.assignedUsers || []).map((a) => String(a.userId)))
      const invalidUserIds = uniqueUserIds.filter((id) => !assignedUserIds.has(id))
      if (invalidUserIds.length > 0) {
        return NextResponse.json({ error: 'One or more selected users are not assigned to this project' }, { status: 400 })
      }

      const assignedUsersById = new Map<string, { id: string; email: string; name: string | null }>()
      for (const row of project.assignedUsers || []) {
        const u = row.user
        if (u?.id && u.email) {
          assignedUsersById.set(String(u.id), { id: String(u.id), email: String(u.email), name: u.name || null })
        }
      }

      const recipients = uniqueUserIds
        .map((id) => assignedUsersById.get(id))
        .filter((u): u is { id: string; email: string; name: string | null } => !!u && !!u.email)

      if (recipients.length === 0) {
        return NextResponse.json({ error: 'No selected users have an email address' }, { status: 400 })
      }

      // Resolve attachments (optional)
      const MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024
      const MAX_EMAIL_ATTACHMENTS_SINGLE_BYTES = 10 * 1024 * 1024

      const uniqueFileIds = Array.from(new Set(requestedFileIds)).filter(Boolean)
      let attachments: NonNullable<Parameters<typeof sendEmail>[0]['attachments']> | undefined = undefined
      let attachmentsMeta: Array<{ fileName: string; fileSizeBytes: number }> = []

      if (uniqueFileIds.length > 0) {
        const files = await prisma.projectFile.findMany({
          where: { id: { in: uniqueFileIds }, projectId },
          select: { id: true, fileName: true, fileType: true, fileSize: true, storagePath: true },
        })

        if (files.length !== uniqueFileIds.length) {
          return NextResponse.json({ error: 'One or more selected files were not found' }, { status: 400 })
        }

        const sizes = files.map((f) => Number(f.fileSize))
        const totalBytes = sizes.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0)
        const oversized = files.filter((f) => Number(f.fileSize) > MAX_EMAIL_ATTACHMENTS_SINGLE_BYTES).map((f) => f.fileName)

        if (oversized.length > 0) {
          return NextResponse.json(
            { error: `One or more attachments are too large to email (max ${Math.round(MAX_EMAIL_ATTACHMENTS_SINGLE_BYTES / 1024 / 1024)}MB each): ${oversized.join(', ')}` },
            { status: 400 }
          )
        }

        if (totalBytes > MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES) {
          return NextResponse.json(
            { error: `Total attachments are too large to email (max ${Math.round(MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024)}MB total)` },
            { status: 400 }
          )
        }

        // Ensure files exist on disk
        for (const f of files) {
          const fullPath = getFilePath(f.storagePath)
          const stat = await fs.promises.stat(fullPath)
          if (!stat.isFile()) {
            return NextResponse.json({ error: `File not found on disk: ${f.fileName}` }, { status: 404 })
          }
        }

        attachments = files.map((f) => ({
          filename: sanitizeFilenameForHeader(f.fileName),
          path: getFilePath(f.storagePath),
          contentType: f.fileType || 'application/octet-stream',
        }))

        attachmentsMeta = files.map((f) => ({ fileName: f.fileName, fileSizeBytes: Number(f.fileSize) }))
      }

      const emailSettings = await getEmailSettings()
      const companyLogoUrl = buildCompanyLogoUrl({
        appDomain: emailSettings.appDomain,
        companyLogoMode: emailSettings.companyLogoMode,
        companyLogoPath: emailSettings.companyLogoPath,
        companyLogoUrl: emailSettings.companyLogoUrl,
        updatedAt: emailSettings.updatedAt,
      })

      let origin = ''
      if (emailSettings.appDomain) {
        try {
          const parsed = new URL(emailSettings.appDomain)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin
        } catch {
          origin = ''
        }
      }

      const projectAdminUrl = origin ? `${origin}/admin/projects/${projectId}` : '#'
      const subject = `Project Invite: ${project.title}`

      for (const recipient of recipients) {
        const html = generateProjectInviteInternalUsersEmail({
          companyName: emailSettings.companyName || 'ViTransfer',
          companyLogoUrl: companyLogoUrl || undefined,
          recipientName: recipient.name || undefined,
          projectTitle: project.title,
          projectAdminUrl,
          notes: trimmedNotes ? trimmedNotes : null,
          attachments: attachmentsMeta,
        })

        const result = await sendEmail({
          to: recipient.email,
          subject,
          html,
          attachments,
        })

        if (!result.success) {
          return NextResponse.json({ error: result.error || 'Failed to send invite email' }, { status: 500 })
        }
      }

      return NextResponse.json({ success: true, message: `Sent invite email to ${recipients.length} user(s).` })
    }

    // Get recipients (client notifications)
    const recipients = await getProjectRecipients(projectId)

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients configured for this project' }, { status: 400 })
    }

    // Generate share URL
    const shareUrl = await generateShareUrl(project.slug)
    const isPasswordProtected = !!project.sharePassword

    const readyAlbums =
      project.enablePhotos === false
        ? []
        : (project.albums || [])
            .map((a) => ({ name: a.name, photoCount: a._count?.photos ?? 0 }))
            .filter((a) => a.photoCount > 0)

    if (notifyEntireProject && project.videos.length === 0 && readyAlbums.length === 0) {
      return NextResponse.json(
        { error: 'There is nothing ready to notify yet.' },
        { status: 400 }
      )
    }

    // Prepare video data if specific video notification
    let video = null
    let album: { id: string; name: string; notes: string | null; projectId: string } | null = null

    const isSpecificAlbum = !notifyEntireProject && !!albumId
    const isSpecificVideo = !notifyEntireProject && !albumId

    if (isSpecificVideo) {
      if (!videoId) {
        return NextResponse.json({ error: 'videoId is required for specific video notification' }, { status: 400 })
      }

      video = await prisma.video.findUnique({
        where: { id: videoId },
        select: {
          name: true,
          versionLabel: true,
          videoNotes: true,
          status: true,
        }
      })

      if (!video) {
        return NextResponse.json({ error: 'Video not found' }, { status: 404 })
      }

      if (video.status !== 'READY') {
        return NextResponse.json(
          { error: 'Video is not ready yet. Please wait for processing to complete.' },
          { status: 400 }
        )
      }
    }

    if (isSpecificAlbum) {
      album = await prisma.album.findUnique({
        where: { id: String(albumId) },
        select: { id: true, name: true, notes: true, projectId: true },
      })

      if (!album || album.projectId !== projectId) {
        return NextResponse.json({ error: 'Album not found' }, { status: 404 })
      }

      // Ensure photos are enabled for this project.
      if (project.enablePhotos === false) {
        return NextResponse.json({ error: 'Photos are disabled for this project' }, { status: 400 })
      }
    }

    const trackingType = notifyEntireProject
      ? 'ALL_READY_VIDEOS'
      : isSpecificAlbum
      ? 'SPECIFIC_ALBUM_READY'
      : 'SPECIFIC_VIDEO_VERSION'

    // Send emails to all recipients with email addresses
    const emailPromises = recipients
      .filter(recipient => recipient.email)
      .map(async (recipient) => {
        // Generate unique tracking token for this email/recipient
        const trackingToken = await prisma.emailTracking.create({
          data: {
            // Do not embed PII (like emails) in tokens that end up in URLs and logs.
            token: crypto.randomBytes(32).toString('base64url'),
            projectId,
            type: trackingType,
            videoId: notifyEntireProject || isSpecificAlbum ? null : videoId,
            recipientEmail: recipient.email!,
          },
        })

        if (notifyEntireProject) {
          return sendProjectGeneralNotificationEmail({
            clientEmail: recipient.email!,
            clientName: recipient.name || 'Client',
            projectTitle: project.title,
            shareUrl,
            readyVideos: project.videos.map(v => ({ name: v.name, versionLabel: v.versionLabel })),
            readyAlbums,
            notes: trimmedNotes ? trimmedNotes : null,
            isPasswordProtected,
            trackingToken: trackingToken.token,
          })
        } else if (isSpecificAlbum) {
          return sendNewAlbumReadyEmail({
            clientEmail: recipient.email!,
            clientName: recipient.name || 'Client',
            projectTitle: project.title,
            albumName: album!.name,
            albumNotes: album!.notes,
            shareUrl,
            isPasswordProtected,
            trackingToken: trackingToken.token,
          })
        } else {
          return sendNewVersionEmail({
            clientEmail: recipient.email!,
            clientName: recipient.name || 'Client',
            projectTitle: project.title,
            videoName: video!.name,
            versionLabel: video!.versionLabel,
            videoNotes: video!.videoNotes || null,
            shareUrl,
            isPasswordProtected,
            trackingToken: trackingToken.token,
          })
        }
      })

    const results = await Promise.allSettled(emailPromises)
    const recipientsWithEmails = recipients.filter(r => r.email)

    const isSendEmailSuccess = (value: unknown): value is { success: true } => {
      if (!value || typeof value !== 'object') return false
      return (value as Record<string, unknown>).success === true
    }

    // Map successes to actual recipient emails using positional alignment
    const successfulRecipientEmails: string[] = []
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled' && isSendEmailSuccess(r.value)) {
        const rec = recipientsWithEmails[idx]
        if (rec?.email) successfulRecipientEmails.push(rec.email)
      }
    })
    const successCount = successfulRecipientEmails.length

    // Send password emails if requested
    let passwordSuccessCount = 0
    let successfulPasswordRecipientEmails: string[] = []
    if (sendPasswordSeparately && isPasswordProtected && project.sharePassword) {
      try {
        // Wait 10 seconds before sending password emails
        await new Promise(resolve => setTimeout(resolve, 10000))

        const decryptedPassword = decrypt(project.sharePassword)

        const passwordPromises = recipients
          .filter(recipient => recipient.email)
          .map(recipient =>
            sendPasswordEmail({
              clientEmail: recipient.email!,
              clientName: recipient.name || 'Client',
              projectTitle: project.title,
              password: decryptedPassword,
            })
          )

        const passwordResults = await Promise.allSettled(passwordPromises)
        passwordResults.forEach((r, idx) => {
          if (r.status === 'fulfilled' && isSendEmailSuccess(r.value)) {
            const rec = recipientsWithEmails[idx]
            if (rec?.email) successfulPasswordRecipientEmails.push(rec.email)
          }
        })
        passwordSuccessCount = successfulPasswordRecipientEmails.length
      } catch (error) {
        console.error('Error sending password emails:', error)
      }
    }

    if (successCount > 0) {
      // If this is the first time we notify clients, move NOT_STARTED/IN_PROGRESS → IN_REVIEW
      // (Display-only state; does not block auto-approval.)
      if (project.status === 'NOT_STARTED' || project.status === 'IN_PROGRESS') {
        const permissions = getUserPermissions(authResult)
        if (permissions.actions.changeProjectStatuses) {
          try {
            const previousStatus = project.status
            await prisma.project.update({
              where: { id: projectId },
              data: { status: 'IN_REVIEW' },
            })

            await prisma.projectStatusChange.create({
              data: {
                projectId,
                previousStatus: previousStatus as any,
                currentStatus: 'IN_REVIEW',
                source: 'SYSTEM',
                changedById: null,
              },
            })
          } catch (e) {
            // Non-blocking: do not fail the email send response
            console.error('Failed to update project status to IN_REVIEW:', e)
          }
        }
      }

      // Log analytics email event (clients only)
      try {
        const recipientEmailsJson = JSON.stringify(successfulRecipientEmails)
        await prisma.projectEmailEvent.create({
          data: {
            projectId,
            type: trackingType,
            videoId: notifyEntireProject || isSpecificAlbum ? null : videoId,
            recipientEmails: recipientEmailsJson,
          },
        })
      } catch (e) {
        // Non-blocking: analytics logging should not prevent response
        console.error('Failed to log ProjectEmailEvent:', e)
      }

      // Format recipient emails for message
      const formatEmailsList = (emails: string[]) => {
        if (emails.length === 1) return emails[0]
        if (emails.length === 2) return `${emails[0]} & ${emails[1]}`
        return emails.slice(0, -1).join(', ') + ' & ' + emails[emails.length - 1]
      }

      let message = `Sent email to ${formatEmailsList(successfulRecipientEmails)}.`
      if (sendPasswordSeparately && isPasswordProtected && passwordSuccessCount > 0) {
        message += ` Password sent to ${formatEmailsList(successfulPasswordRecipientEmails)}.`
      }
      return NextResponse.json({ success: true, message })
    } else {
      return NextResponse.json(
        { error: 'Failed to send emails to any recipients' },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Notify error:', error)
    return NextResponse.json(
      { error: 'Failed to send notification' },
      { status: 500 }
    )
  }
}
