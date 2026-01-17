import { prisma } from '../lib/db'
import { buildCompanyLogoUrl, getEmailSettings, renderProjectKeyDateReminderEmail, sendEmail } from '../lib/email'

type ReminderTargets = {
  userIds?: string[]
}

export async function processUserKeyDateReminders() {
  const now = new Date()

  const due = await prisma.userKeyDate.findMany({
    where: {
      reminderAt: { not: null, lte: now },
      reminderSentAt: null,
      reminderAttemptCount: { lt: 5 },
    },
    select: {
      id: true,
      userId: true,
      date: true,
      allDay: true,
      startTime: true,
      finishTime: true,
      title: true,
      notes: true,
      reminderAt: true,
      reminderTargets: true,
      reminderAttemptCount: true,
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

  const base = (settings.appDomain || '').replace(/\/$/, '')
  const dashboardUrl = base ? `${base}/admin/projects` : '#'

  for (const kd of due) {
    const targets = (kd.reminderTargets || null) as any as ReminderTargets | null

    // Default to the owner if no targets were stored (backward/defensive)
    const userIds = Array.isArray(targets?.userIds)
      ? targets!.userIds!.map(String).filter(Boolean)
      : [String(kd.userId)]

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { email: true },
    })

    const emails = new Set<string>()
    for (const u of users) {
      if (!u?.email) continue
      emails.add(String(u.email).trim())
    }

    const bcc = Array.from(emails).filter((e) => e.includes('@'))

    try {
      await prisma.userKeyDate.update({
        where: { id: kd.id },
        data: {
          reminderLastAttemptAt: now,
          reminderAttemptCount: { increment: 1 },
        },
      })

      if (bcc.length === 0) {
        await prisma.userKeyDate.update({
          where: { id: kd.id },
          data: {
            reminderLastError: 'Reminder has no valid recipients',
          },
        })
        continue
      }

      const rendered = await renderProjectKeyDateReminderEmail({
        // Personal: omit the Project card
        projectTitle: undefined,
        projectCompanyName: undefined,
        shareUrl: dashboardUrl,
        primaryActionLabel: 'View Dashboard',
        keyDate: {
          date: kd.date,
          allDay: kd.allDay,
          startTime: kd.startTime,
          finishTime: kd.finishTime,
          type: kd.title,
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
        await prisma.userKeyDate.update({
          where: { id: kd.id },
          data: {
            reminderLastError: sendResult.error || 'Failed to send reminder',
          },
        })
        continue
      }

      await prisma.userKeyDate.update({
        where: { id: kd.id },
        data: {
          reminderSentAt: now,
          reminderLastError: null,
        },
      })
    } catch (e: any) {
      await prisma.userKeyDate.update({
        where: { id: kd.id },
        data: {
          reminderLastError: e?.message || 'Failed to process reminder',
        },
      })
    }
  }
}
