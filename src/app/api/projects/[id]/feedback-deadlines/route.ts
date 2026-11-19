import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getActiveFeedbackDeadlines } from '@/lib/feedback-reminders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Active feedback deadlines for a project — feeds the manual "Feedback Reminder"
 * option in the Send Notification dialog. Same gates as POST /notify.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'sendNotificationsToRecipients')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.',
  }, 'project-feedback-deadlines', authResult.id)
  if (rateLimitResult) return rateLimitResult

  const { id: projectId } = await params
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true } })
  if (!project || !isVisibleProjectStatusForUser(authResult, project.status)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const { deadlines } = await getActiveFeedbackDeadlines(projectId)
  return NextResponse.json(
    {
      deadlines: deadlines.map((d) => ({
        videoId: d.videoId,
        name: d.name,
        versionLabel: d.versionLabel,
        feedbackDueDate: d.feedbackDueDate,
        lastReminderAt: d.lastReminderAt ? d.lastReminderAt.toISOString() : null,
        hasClientComment: d.hasClientComment,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
