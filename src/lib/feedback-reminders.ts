import crypto from 'crypto'
import type { NextRequest } from 'next/server'
import { prisma } from './db'
import { renderFeedbackReminderEmail, sendEmail } from './email'
import { generateShareUrl } from './url'
import { buildUnsubscribeUrl } from './unsubscribe'
import { isFeedbackDeadlineActive } from './feedback-deadline'

/**
 * Feedback deadline reminders — shared by the scheduled worker job
 * (src/worker/feedback-deadline-reminders.ts) and the manual "Feedback Reminder"
 * option in the project's Send Notification dialog.
 */

export const FEEDBACK_REMINDER_EMAIL_TYPE = 'FEEDBACK_REMINDER'

export type ProjectFeedbackDeadline = {
  videoId: string
  name: string
  versionLabel: string
  feedbackDueDate: string
  createdAt: Date
  lastReminderAt: Date | null
  /** A client (non-internal) comment or reply exists on this exact version. */
  hasClientComment: boolean
}

/**
 * Every version in the project whose feedback deadline is still active
 * (see isFeedbackDeadlineActive), with whether the client has already commented on it.
 */
export async function getActiveFeedbackDeadlines(projectId: string): Promise<{
  projectStatus: string | null
  deadlines: ProjectFeedbackDeadline[]
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      status: true,
      videos: {
        where: { status: 'READY' },
        select: {
          id: true,
          name: true,
          version: true,
          versionLabel: true,
          status: true,
          approved: true,
          revisionRequestedAt: true,
          feedbackDueDate: true,
          feedbackDueLastReminderAt: true,
          createdAt: true,
        },
      },
    },
  })
  if (!project) return { projectStatus: null, deadlines: [] }

  const active = project.videos.filter((v) =>
    isFeedbackDeadlineActive(v, project.videos.filter((g) => g.name === v.name), project.status)
  )
  if (active.length === 0) return { projectStatus: project.status, deadlines: [] }

  const commented = await prisma.comment.findMany({
    where: { videoId: { in: active.map((v) => v.id) }, isInternal: false },
    select: { videoId: true },
    distinct: ['videoId'],
  })
  const commentedIds = new Set(commented.map((c) => c.videoId))

  return {
    projectStatus: project.status,
    deadlines: active
      .map((v) => ({
        videoId: v.id,
        name: v.name,
        versionLabel: v.versionLabel,
        feedbackDueDate: v.feedbackDueDate as string,
        createdAt: v.createdAt,
        lastReminderAt: v.feedbackDueLastReminderAt,
        hasClientComment: commentedIds.has(v.id),
      }))
      .sort((a, b) => a.feedbackDueDate.localeCompare(b.feedbackDueDate) || a.name.localeCompare(b.name)),
  }
}

/**
 * Send one reminder email per recipient listing `deadlines`, then stamp
 * feedbackDueLastReminderAt on those versions and log the email event.
 *
 * `recipientIds` limits the send to those project recipients (manual send); when
 * omitted, every recipient with an email and notifications enabled is used.
 */
export async function sendFeedbackReminderEmails(params: {
  projectId: string
  deadlines: Array<Pick<ProjectFeedbackDeadline, 'videoId' | 'name' | 'versionLabel' | 'feedbackDueDate'>>
  recipientIds?: string[]
  /** Manual sends pass the request so the share URL resolves without a configured app domain. */
  request?: NextRequest
  /** Test seam: replaces the SMTP send. */
  sendEmailFn?: typeof sendEmail
}): Promise<{ sentTo: string[]; failed: number; error?: string }> {
  const { projectId, deadlines } = params
  const send = params.sendEmailFn ?? sendEmail
  if (deadlines.length === 0) return { sentTo: [], failed: 0, error: 'No active feedback deadlines' }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      slug: true,
      authMode: true,
      sharePassword: true,
      recipients: {
        select: { id: true, email: true, name: true, receiveNotifications: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      },
    },
  })
  if (!project) return { sentTo: [], failed: 0, error: 'Project not found' }

  const wanted = params.recipientIds ? new Set(params.recipientIds) : null
  const recipients = project.recipients.filter((r) =>
    r.email && r.email.includes('@') && (wanted ? wanted.has(r.id) : r.receiveNotifications)
  )
  if (recipients.length === 0) return { sentTo: [], failed: 0, error: 'No eligible recipients' }

  let shareUrl: string
  try {
    shareUrl = await generateShareUrl(project.slug, params.request)
  } catch {
    return { sentTo: [], failed: 0, error: 'App domain is not configured (Settings → Domain)' }
  }
  const isPasswordProtected = (project.authMode === 'PASSWORD' || project.authMode === 'BOTH') && !!project.sharePassword
  let appOrigin: string | null = null
  try {
    appOrigin = new URL(shareUrl).origin
  } catch {
    appOrigin = null
  }

  const singleVideoId = deadlines.length === 1 ? deadlines[0].videoId : null
  const sentTo: string[] = []
  let failed = 0

  for (const r of recipients) {
    try {
      const tracking = await prisma.emailTracking.create({
        data: {
          token: crypto.randomBytes(32).toString('base64url'),
          projectId,
          type: FEEDBACK_REMINDER_EMAIL_TYPE,
          videoId: singleVideoId,
          recipientEmail: r.email!,
        },
      })
      const rendered = await renderFeedbackReminderEmail({
        clientName: r.name || 'there',
        projectTitle: project.title,
        shareUrl,
        videos: deadlines.map((d) => ({ name: d.name, versionLabel: d.versionLabel, feedbackDueDate: d.feedbackDueDate })),
        isPasswordProtected,
        unsubscribeUrl: appOrigin ? buildUnsubscribeUrl(appOrigin, projectId, r.id) : undefined,
        trackingToken: tracking.token,
      })
      const result = await send({ to: r.email!, subject: rendered.subject, html: rendered.html })
      if (result.success) sentTo.push(r.email!)
      else failed += 1
    } catch (e) {
      failed += 1
      console.error('[FEEDBACK-REMINDER] Send failed:', e instanceof Error ? e.message : e)
    }
  }

  if (sentTo.length > 0) {
    await prisma.video.updateMany({
      where: { id: { in: deadlines.map((d) => d.videoId) } },
      data: { feedbackDueLastReminderAt: new Date() },
    })
    try {
      await prisma.projectEmailEvent.create({
        data: {
          projectId,
          type: FEEDBACK_REMINDER_EMAIL_TYPE,
          videoId: singleVideoId,
          recipientEmails: JSON.stringify(sentTo),
        },
      })
    } catch (e) {
      console.error('[FEEDBACK-REMINDER] Failed to log ProjectEmailEvent:', e)
    }
  }

  return { sentTo, failed, error: sentTo.length === 0 ? 'Failed to send to any recipient' : undefined }
}
