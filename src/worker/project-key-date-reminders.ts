import { prisma } from '../lib/db'
import { buildCompanyLogoUrl, getEmailSettings, renderProjectKeyDateReminderEmail, sendEmail } from '../lib/email'
import { generateShareUrl } from '../lib/url'

type ReminderTargets = {
  userIds?: string[]
  recipientIds?: string[]
}

export async function processProjectKeyDateReminders() {
  const now = new Date()

  const due = await prisma.projectKeyDate.findMany({
    where: {
      reminderAt: { not: null, lte: now },
      reminderSentAt: null,
      reminderAttemptCount: { lt: 5 },
    },
    select: {
      id: true,
      projectId: true,
      date: true,
      allDay: true,
      startTime: true,
      finishTime: true,
      type: true,
      notes: true,
      reminderAt: true,
      reminderTargets: true,
      reminderAttemptCount: true,
      project: {
        select: {
          title: true,
          slug: true,
          companyName: true,
          recipients: { select: { id: true, email: true, name: true } },
          assignedUsers: { select: { user: { select: { id: true, email: true, name: true } } } },
        },
      },
    },
    orderBy: [{ reminderAt: 'asc' }, { createdAt: 'asc' }],
    take: 50,
  })

  if (due.length === 0) return

  const settings = await getEmailSettings()
  const fromAddress = settings.smtpFromAddress || settings.smtpUsername || 'noreply@vitransfer.com'
  const companyName = settings.companyName || 'Studio'

  const companyLogoUrl = buildCompanyLogoUrl({
    appDomain: settings.appDomain,
    companyLogoMode: settings.companyLogoMode,
    companyLogoPath: settings.companyLogoPath,
    companyLogoUrl: settings.companyLogoUrl,
    updatedAt: settings.updatedAt,
  })

  for (const kd of due) {
    const targets = (kd.reminderTargets || null) as any as ReminderTargets | null
    const userIds = Array.isArray(targets?.userIds) ? targets!.userIds!.map(String).filter(Boolean) : []
    const recipientIds = Array.isArray(targets?.recipientIds) ? targets!.recipientIds!.map(String).filter(Boolean) : []

    const emails = new Set<string>()

    // Assigned users
    for (const au of kd.project.assignedUsers || []) {
      const u = (au as any)?.user
      if (!u?.email) continue
      if (!userIds.includes(String(u.id))) continue
      emails.add(String(u.email).trim())
    }

    // Project recipients
    for (const r of kd.project.recipients || []) {
      if (!r?.email) continue
      if (!recipientIds.includes(String(r.id))) continue
      emails.add(String(r.email).trim())
    }

    const bcc = Array.from(emails).filter((e) => e.includes('@'))

    try {
      await prisma.projectKeyDate.update({
        where: { id: kd.id },
        data: {
          reminderLastAttemptAt: now,
          reminderAttemptCount: { increment: 1 },
        },
      })

      if (bcc.length === 0) {
        await prisma.projectKeyDate.update({
          where: { id: kd.id },
          data: {
            reminderLastError: 'Reminder has no valid recipients',
          },
        })
        continue
      }

      const shareUrl = await generateShareUrl(kd.project.slug)
      const rendered = await renderProjectKeyDateReminderEmail({
        projectTitle: kd.project.title,
        projectCompanyName: kd.project.companyName,
        shareUrl,
        keyDate: {
          date: kd.date,
          allDay: kd.allDay,
          startTime: kd.startTime,
          finishTime: kd.finishTime,
          type: kd.type,
          notes: kd.notes,
        },
        branding: {
          companyName,
          companyLogoUrl,
          trackingPixelsEnabled: settings.emailTrackingPixelsEnabled ?? true,
          appDomain: settings.appDomain || undefined,
        },
      })

      const sendResult = await sendEmail({
        to: fromAddress,
        bcc,
        subject: rendered.subject,
        html: rendered.html,
      })

      if (!sendResult.success) {
        await prisma.projectKeyDate.update({
          where: { id: kd.id },
          data: {
            reminderLastError: sendResult.error || 'Failed to send reminder',
          },
        })
        continue
      }

      await prisma.projectKeyDate.update({
        where: { id: kd.id },
        data: {
          reminderSentAt: now,
          reminderLastError: null,
        },
      })
    } catch (e: any) {
      await prisma.projectKeyDate.update({
        where: { id: kd.id },
        data: {
          reminderLastError: e?.message || 'Failed to process reminder',
        },
      })
    }
  }
}
