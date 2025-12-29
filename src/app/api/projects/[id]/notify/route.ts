import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendNewVersionEmail, sendProjectGeneralNotificationEmail, sendPasswordEmail, isSmtpConfigured } from '@/lib/email'
import { generateShareUrl } from '@/lib/url'
import { requireApiAdmin } from '@/lib/auth'
import { decrypt } from '@/lib/encryption'
import { getProjectRecipients } from '@/lib/recipients'
import { rateLimit } from '@/lib/rate-limit'
export const runtime = 'nodejs'



export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Require admin
    const authResult = await requireApiAdmin(request)
    if (authResult instanceof Response) {
      return authResult
    }

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
    const { videoId, notifyEntireProject, sendPasswordSeparately } = body

    // Get project details including password
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        title: true,
        description: true,
        slug: true,
        sharePassword: true,
        videos: {
          where: { status: 'READY' },
          select: {
            id: true,
            name: true,
            versionLabel: true,
            status: true,
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Get recipients
    const recipients = await getProjectRecipients(projectId)

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients configured for this project' }, { status: 400 })
    }

    // Generate share URL
    const shareUrl = await generateShareUrl(project.slug)
    const isPasswordProtected = !!project.sharePassword

    // Prepare video data if specific video notification
    let video = null
    if (!notifyEntireProject) {
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

    // Send emails to all recipients with email addresses
    const emailPromises = recipients
      .filter(recipient => recipient.email)
      .map(async (recipient) => {
        // Generate unique tracking token for this email/recipient
        const trackingToken = await prisma.emailTracking.create({
          data: {
            token: `${projectId}-${recipient.email}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            projectId,
            type: notifyEntireProject ? 'ALL_READY_VIDEOS' : 'SPECIFIC_VIDEO_VERSION',
            videoId: notifyEntireProject ? null : videoId,
            recipientEmail: recipient.email!,
          },
        })

        if (notifyEntireProject) {
          return sendProjectGeneralNotificationEmail({
            clientEmail: recipient.email!,
            clientName: recipient.name || 'Client',
            projectTitle: project.title,
            projectDescription: project.description || '',
            shareUrl,
            readyVideos: project.videos.map(v => ({ name: v.name, versionLabel: v.versionLabel })),
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
            videoNotes: (video as any).videoNotes || '',
            shareUrl,
            isPasswordProtected,
            trackingToken: trackingToken.token,
          })
        }
      })

    const results = await Promise.allSettled(emailPromises)
    const recipientsWithEmails = recipients.filter(r => r.email)
    // Map successes to actual recipient emails using positional alignment
    const successfulRecipientEmails: string[] = []
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled' && (r.value as any).success) {
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
          if (r.status === 'fulfilled' && (r.value as any).success) {
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
      // Log analytics email event (clients only)
      try {
        const recipientEmailsJson = JSON.stringify(successfulRecipientEmails)
        await prisma.projectEmailEvent.create({
          data: {
            projectId,
            type: notifyEntireProject ? 'ALL_READY_VIDEOS' : 'SPECIFIC_VIDEO_VERSION',
            videoId: notifyEntireProject ? null : videoId,
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
