import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendNewAlbumReadyEmail, sendNewVersionEmail, sendProjectGeneralNotificationEmail, sendNewItemsReadyEmail, isSmtpConfigured, getEmailSettings, buildCompanyLogoUrl, sendEmail } from '@/lib/email'
import { getPasswordEmailQueue } from '@/lib/queue'
import { generateNotificationSummaryEmail, generateProjectInviteInternalUsersEmail, generateAdminSummaryEmail } from '@/lib/email-templates'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { generateShareUrl } from '@/lib/url'
import { requireApiAuth } from '@/lib/auth'
import { getProjectRecipients } from '@/lib/recipients'
import { buildUnsubscribeUrl } from '@/lib/unsubscribe'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions, isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import crypto from 'crypto'
import { getRedis } from '@/lib/redis'
import { getPeriodString, normalizeNotificationDataTimecode, sendNotificationsWithRetry, sendSummaryToRecipients, notificationBatchHash, tryAcquireSendLock, releaseSendLock, clientSendLockKey, ADMIN_SEND_LOCK_KEY } from '@/worker/notification-helpers'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { getStoredFileRecords } from '@/lib/stored-file'
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
    const { videoId, albumId, videoIds, albumIds, notifyEntireProject, sendPasswordSeparately, notes, notificationType, internalUserIds, projectFileIds, recipientIds } = body

    const trimmedNotes = typeof notes === 'string' ? notes.trim() : ''

    const isInternalInvite = notificationType === 'internal-invite'
    const isCommentSummary = notificationType === 'comment-summary'

    // Get project details including password
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        title: true,
        slug: true,
        sharePassword: true,
        authMode: true,
        status: true,
        enablePhotos: true,
        useFullTimecode: true,
        clientNotificationSchedule: true,
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
            approved: true,
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
          select: { id: true, fileName: true, fileType: true },
        })

        if (files.length !== uniqueFileIds.length) {
          return NextResponse.json({ error: 'One or more selected files were not found' }, { status: 400 })
        }

        // Resolve file sizes and storage paths from StoredFile
        const storedFiles = await getStoredFileRecords('PROJECT_FILE', files.map(f => f.id), {
          fileRoles: ['ORIGINAL'],
          select: { entityId: true, fileSize: true, storagePath: true },
        }) as unknown as Array<{ entityId: string; fileSize: bigint | null; storagePath: string | null }>
        const sizeByFileId = new Map(storedFiles.map(s => [s.entityId, s.fileSize ? Number(s.fileSize) : 0] as const))
        const pathByFileId = new Map(storedFiles.filter(s => s.storagePath).map(s => [s.entityId, s.storagePath!] as const))

        const sizes = files.map((f) => sizeByFileId.get(f.id) ?? 0)
        const totalBytes = sizes.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0)
        const oversized = files.filter((f) => (sizeByFileId.get(f.id) ?? 0) > MAX_EMAIL_ATTACHMENTS_SINGLE_BYTES).map((f) => f.fileName)

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
          const fPath = pathByFileId.get(f.id)
          if (!fPath) {
            return NextResponse.json({ error: `File not found on disk: ${f.fileName}` }, { status: 404 })
          }
          const fullPath = getFilePath(fPath)
          const stat = await fs.promises.stat(fullPath)
          if (!stat.isFile()) {
            return NextResponse.json({ error: `File not found on disk: ${f.fileName}` }, { status: 404 })
          }
        }

        attachments = files.map((f) => ({
          filename: sanitizeFilenameForHeader(f.fileName),
          path: getFilePath(pathByFileId.get(f.id)!),
          contentType: f.fileType || 'application/octet-stream',
        }))

        attachmentsMeta = files.map((f) => ({ fileName: f.fileName, fileSizeBytes: sizeByFileId.get(f.id) ?? 0 }))
      }

      const emailSettings = await getEmailSettings()
      const companyLogoUrl = buildCompanyLogoUrl({
        appDomain: emailSettings.appDomain,
        companyLogoMode: emailSettings.companyLogoMode,
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
          mainCompanyDomain: emailSettings.mainCompanyDomain,
          accentColor: emailSettings.accentColor || undefined,
          accentTextMode: emailSettings.accentTextMode || undefined,
          emailHeaderColor: emailSettings.emailHeaderColor || undefined,
          emailHeaderTextMode: emailSettings.emailHeaderTextMode || undefined,
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

    // COMMENT SUMMARY: send pending comment summaries to client recipients AND internal users
    if (isCommentSummary) {
      // Load all pending notifications for this project where either side still needs sending
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const allPending = await prisma.notificationQueue.findMany({
        where: {
          projectId,
          type: { in: ['ADMIN_REPLY', 'CLIENT_COMMENT'] },
          createdAt: { gte: sevenDaysAgo },
          OR: [
            { sentToClients: false, clientFailed: false, clientAttempts: { lt: 3 } },
            { sentToAdmins: false, adminFailed: false, adminAttempts: { lt: 3 } },
          ],
        },
        orderBy: { createdAt: 'asc' },
      })

      if (allPending.length === 0) {
        return NextResponse.json({ error: 'No pending comment summaries to send.' }, { status: 400 })
      }

      // Filter out cancelled notifications (comment was deleted)
      const redis = getRedis()
      const validNotifications: typeof allPending = []
      const cancelledNotificationIds: string[] = []

      for (const notification of allPending) {
        const commentId = (notification.data as any).commentId
        if (commentId) {
          const isCancelled = await redis.get(`comment_cancelled:${commentId}`)
          if (isCancelled) {
            cancelledNotificationIds.push(notification.id)
            continue
          }
        }
        validNotifications.push(notification)
      }

      if (cancelledNotificationIds.length > 0) {
        await prisma.notificationQueue.deleteMany({
          where: { id: { in: cancelledNotificationIds } }
        })
      }

      if (validNotifications.length === 0) {
        return NextResponse.json({ error: 'No valid comment summaries to send.' }, { status: 400 })
      }

      // Split by side
      const clientPending = validNotifications.filter(n => !n.sentToClients && !n.clientFailed && n.clientAttempts < 3)
      const adminPending  = validNotifications.filter(n => !n.sentToAdmins  && !n.adminFailed  && n.adminAttempts  < 3)

      // Shared email settings
      const emailSettings = await getEmailSettings()
      const shareUrl = await generateShareUrl(project.slug)
      let appDomain = new URL(shareUrl).origin
      if (emailSettings.appDomain) {
        try {
          const parsed = new URL(emailSettings.appDomain)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') appDomain = parsed.origin
        } catch {
          // fallback to shareUrl origin
        }
      }
      const trackingPixelsEnabled = emailSettings.emailTrackingPixelsEnabled ?? true
      const companyLogoUrl = buildCompanyLogoUrl({
        appDomain,
        companyLogoMode: emailSettings.companyLogoMode,
        companyLogoUrl: emailSettings.companyLogoUrl,
        updatedAt: emailSettings.updatedAt,
      })

      let clientSent = false
      let adminSent  = false
      let lastError: string | undefined

      // ── CLIENT SIDE ────────────────────────────────────────────────────────
      if (clientPending.length > 0) {
        const allRecipients = await getProjectRecipients(projectId)
        const recipients = allRecipients.filter((r) => r.receiveNotifications && r.email)

        if (recipients.length > 0) {
          const clientIds = clientPending.map((n) => n.id)
          const period = getPeriodString(project.clientNotificationSchedule)

          // Serialize against the scheduled worker so the two paths can't both fire this
          // project's client summary at once. If the worker holds the lock, leave the
          // notifications pending — the scheduled run will deliver them shortly.
          const lockKey = clientSendLockKey(project.id)
          if (!(await tryAcquireSendLock(lockKey))) {
            lastError = 'A summary is already being sent for this project; it will be delivered shortly.'
          } else {
            try {
              await prisma.notificationQueue.updateMany({
                where: { id: { in: clientIds } },
                data: { clientAttempts: { increment: 1 } },
              })
              const currentAttempts = (clientPending[0]?.clientAttempts ?? 0) + 1
              // Identical hash to the scheduled worker (same ids + `${project.id}|${period}`
              // salt) so per-recipient idempotency markers are shared across both paths.
              const batchHash = notificationBatchHash(clientIds, `${project.id}|${period}`)
              const notifications = clientPending.map((n) => normalizeNotificationDataTimecode(n.data as any))

              const clientResult = await sendNotificationsWithRetry({
                notificationIds: clientIds,
                currentAttempts,
                isClientNotification: true,
                logPrefix: '[CLIENT-MANUAL]',
                onSuccess: async () => {
                  const { sentEmails: successfulRecipientEmails } = await sendSummaryToRecipients({
                    channel: 'client',
                    batchHash,
                    recipients,
                    getEmail: (r) => r.email,
                    logPrefix: '[CLIENT-MANUAL]',
                    sendOne: async (recipient) => {
                      const normalizedEmail = recipient.email!.toLowerCase()
                      const stableToken = `${project.id}-${batchHash}-${normalizedEmail}`
                      const trackingToken = trackingPixelsEnabled
                        ? await prisma.emailTracking.upsert({
                            where: { token: stableToken },
                            update: { sentAt: new Date() },
                            create: {
                              token: stableToken,
                              projectId: project.id,
                              type: 'COMMENT_SUMMARY',
                              videoId: null,
                              recipientEmail: normalizedEmail,
                            },
                          })
                        : null

                      const html = generateNotificationSummaryEmail({
                        companyName: emailSettings.companyName || 'ViTransfer',
                        projectTitle: project.title,
                        useFullTimecode: project.useFullTimecode,
                        shareUrl,
                        unsubscribeUrl: recipient.id ? buildUnsubscribeUrl(appDomain, project.id, recipient.id) : undefined,
                        recipientName: recipient.name || recipient.email!,
                        recipientEmail: recipient.email!,
                        period,
                        notifications,
                        trackingToken: trackingToken?.token,
                        trackingPixelsEnabled,
                        appDomain,
                        companyLogoUrl: companyLogoUrl || undefined,
                        mainCompanyDomain: emailSettings.mainCompanyDomain,
                        emailCustomFooterText: emailSettings.emailCustomFooterText,
                        accentColor: emailSettings.accentColor || undefined,
                        accentTextMode: emailSettings.accentTextMode || undefined,
                        emailHeaderColor: emailSettings.emailHeaderColor || undefined,
                        emailHeaderTextMode: emailSettings.emailHeaderTextMode || undefined,
                      })

                      return sendEmail({ to: recipient.email!, subject: `Updates on ${project.title}`, html })
                    },
                  })

                  if (successfulRecipientEmails.length > 0) {
                    try {
                      await prisma.projectEmailEvent.create({
                        data: {
                          projectId: project.id,
                          type: 'COMMENT_SUMMARY',
                          dedupeKey: `COMMENT_SUMMARY:${project.id}:${batchHash}`,
                          videoId: null,
                          recipientEmails: JSON.stringify(successfulRecipientEmails),
                        },
                      })
                    } catch (e: any) {
                      if (e?.code !== 'P2002') console.error('Failed to log ProjectEmailEvent:', e)
                    }
                  }
                },
              })

              if (clientResult.success) {
                clientSent = true
                await prisma.project.update({ where: { id: project.id }, data: { lastClientNotificationSent: new Date() } })
              } else {
                lastError = clientResult.lastError
              }
            } finally {
              await releaseSendLock(lockKey)
            }
          }
        }
      }

      // ── ADMIN/INTERNAL SIDE ────────────────────────────────────────────────
      if (adminPending.length > 0) {
        const assignedUsers = await prisma.projectUser.findMany({
          where: { projectId, receiveNotifications: true },
          select: {
            user: {
              select: {
                id: true, email: true, name: true,
                appRole: { select: { permissions: true, name: true, isSystemAdmin: true } },
              },
            },
          },
        })

        // Filter to users with Share Page access, same rules as the automated worker
        const internalRecipients = assignedUsers
          .map((r) => r.user)
          .filter((u): u is NonNullable<typeof u> & { email: string } => {
            if (!u?.email) return false
            const role = u.appRole
            const isAdminRole = role?.isSystemAdmin === true ||
              (typeof role?.name === 'string' && role.name.trim().toLowerCase() === 'admin')
            if (isAdminRole) return true
            const permissions = normalizeRolePermissions(role?.permissions)
            return canDoAction(permissions, 'accessSharePage')
          })

        if (internalRecipients.length > 0) {
          const adminIds = adminPending.map((n) => n.id)

          // Serialize against the scheduled worker's (global) admin run so both paths can't
          // fire admin summaries at once. If the worker holds the lock, leave these pending.
          if (!(await tryAcquireSendLock(ADMIN_SEND_LOCK_KEY))) {
            lastError = 'An admin summary is already being sent; it will be delivered shortly.'
          } else {
            try {
              await prisma.notificationQueue.updateMany({
                where: { id: { in: adminIds } },
                data: { adminAttempts: { increment: 1 } },
              })
              const currentAttempts = (adminPending[0]?.adminAttempts ?? 0) + 1
              const batchHash = notificationBatchHash(adminIds)

              const globalSettings = await prisma.settings.findUnique({
                where: { id: 'default' },
                select: { adminNotificationSchedule: true },
              })
              const period = getPeriodString(globalSettings?.adminNotificationSchedule || 'IMMEDIATE')
              const adminNotifications = adminPending.map((n) => normalizeNotificationDataTimecode(n.data as any))

              const adminResult = await sendNotificationsWithRetry({
                notificationIds: adminIds,
                currentAttempts,
                isClientNotification: false,
                logPrefix: '[ADMIN-MANUAL]',
                onSuccess: async () => {
                  await sendSummaryToRecipients({
                    channel: 'admin',
                    batchHash,
                    recipients: internalRecipients,
                    getEmail: (u) => u.email,
                    logPrefix: '[ADMIN-MANUAL]',
                    sendOne: async (user) => {
                      const html = generateAdminSummaryEmail({
                        companyName: emailSettings.companyName || 'ViTransfer',
                        adminName: user.name || '',
                        period,
                        companyLogoUrl: companyLogoUrl || undefined,
                        mainCompanyDomain: emailSettings.mainCompanyDomain,
                        accentTextMode: emailSettings.accentTextMode || undefined,
                        emailHeaderColor: emailSettings.emailHeaderColor || undefined,
                        emailHeaderTextMode: emailSettings.emailHeaderTextMode || undefined,
                        accentColor: emailSettings.accentColor || undefined,
                        projects: [{
                          projectTitle: project.title,
                          useFullTimecode: project.useFullTimecode,
                          shareUrl,
                          notifications: adminNotifications,
                        }],
                      })
                      return sendEmail({
                        to: user.email,
                        subject: `Project activity summary — ${project.title}`,
                        html,
                      })
                    },
                  })
                },
              })

              if (adminResult.success) {
                adminSent = true
                await prisma.settings.update({ where: { id: 'default' }, data: { lastAdminNotificationSent: new Date() } })
              } else {
                lastError = adminResult.lastError
              }
            } finally {
              await releaseSendLock(ADMIN_SEND_LOCK_KEY)
            }
          }
        }
      }

      if (!clientSent && !adminSent) {
        return NextResponse.json({ error: lastError || 'No notifications could be sent (no eligible recipients).' }, { status: 500 })
      }

      const sentTo: string[] = []
      if (clientSent) sentTo.push('client recipients')
      if (adminSent)  sentTo.push('internal users')
      return NextResponse.json({ success: true, message: `Comment summary sent to ${sentTo.join(' and ')}.` })
    }

    // Get recipients (client notifications)
    const recipients = await getProjectRecipients(projectId)

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients configured for this project' }, { status: 400 })
    }

    // Optional filtering: if recipientIds are provided, only email those recipients
    const requestedRecipientIds: string[] = Array.isArray(recipientIds) ? recipientIds.map((x: any) => String(x)) : []
    const uniqueRecipientIds = Array.from(new Set(requestedRecipientIds)).filter(Boolean)

    let filteredRecipients = recipients
    if (uniqueRecipientIds.length > 0) {
      const availableIds = new Set(recipients.map((r) => String(r.id || '')))
      const invalidIds = uniqueRecipientIds.filter((id) => !availableIds.has(id))
      if (invalidIds.length > 0) {
        return NextResponse.json({ error: 'One or more selected recipients are not part of this project' }, { status: 400 })
      }

      filteredRecipients = recipients.filter((r) => r.id && uniqueRecipientIds.includes(String(r.id)))
    }

    const filteredRecipientsWithEmail = filteredRecipients.filter((r) => r.email)
    if (filteredRecipientsWithEmail.length === 0) {
      return NextResponse.json({ error: 'No selected recipients have an email address' }, { status: 400 })
    }

    // Generate share URL
    const shareUrl = await generateShareUrl(project.slug)
    const isPasswordProtected = (project.authMode === 'PASSWORD' || project.authMode === 'BOTH') && !!project.sharePassword

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

    const isSelectedItems = notificationType === 'selected-items'
    const isSpecificAlbum = !notifyEntireProject && !isSelectedItems && !!albumId
    const isSpecificVideo = !notifyEntireProject && !isSelectedItems && !albumId

    // Selected items: a hand-picked subset of ready videos and/or albums (not the whole project)
    let selectedVideos: Array<{ name: string; versionLabel: string; approved: boolean }> = []
    let selectedAlbums: Array<{ name: string; photoCount: number }> = []

    if (isSelectedItems) {
      const requestedVideoIds = Array.from(
        new Set((Array.isArray(videoIds) ? videoIds : []).map((x: any) => String(x)).filter(Boolean))
      )
      const requestedAlbumIds = Array.from(
        new Set((Array.isArray(albumIds) ? albumIds : []).map((x: any) => String(x)).filter(Boolean))
      )

      if (requestedVideoIds.length === 0 && requestedAlbumIds.length === 0) {
        return NextResponse.json({ error: 'Please select at least one video or album to notify about.' }, { status: 400 })
      }

      if (requestedVideoIds.length > 0) {
        const readyVideoById = new Map(project.videos.map((v) => [v.id, v]))
        const invalidVideoIds = requestedVideoIds.filter((id) => !readyVideoById.has(id))
        if (invalidVideoIds.length > 0) {
          return NextResponse.json(
            { error: 'One or more selected videos are not ready or not part of this project.' },
            { status: 400 }
          )
        }
        selectedVideos = requestedVideoIds.map((id) => {
          const v = readyVideoById.get(id)!
          return { name: v.name, versionLabel: v.versionLabel, approved: v.approved }
        })
      }

      if (requestedAlbumIds.length > 0) {
        if (project.enablePhotos === false) {
          return NextResponse.json({ error: 'Photos are disabled for this project' }, { status: 400 })
        }
        const albumById = new Map((project.albums || []).map((a) => [a.id, a]))
        const invalidAlbumIds = requestedAlbumIds.filter((id) => !albumById.has(id))
        if (invalidAlbumIds.length > 0) {
          return NextResponse.json(
            { error: 'One or more selected albums are not part of this project.' },
            { status: 400 }
          )
        }
        selectedAlbums = requestedAlbumIds.map((id) => {
          const a = albumById.get(id)!
          return { name: a.name, photoCount: a._count?.photos ?? 0 }
        })
      }
    }

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
      : isSelectedItems
      ? 'SELECTED_ITEMS_READY'
      : isSpecificAlbum
      ? 'SPECIFIC_ALBUM_READY'
      : 'SPECIFIC_VIDEO_VERSION'

    // Emails that cover more than a single video version don't get a videoId link.
    const hasSingleVideo = isSpecificVideo

    // Send emails to all recipients with email addresses
    const emailPromises = filteredRecipientsWithEmail
      .map(async (recipient) => {
        // Generate unique tracking token for this email/recipient
        const trackingToken = await prisma.emailTracking.create({
          data: {
            // Do not embed PII (like emails) in tokens that end up in URLs and logs.
            token: crypto.randomBytes(32).toString('base64url'),
            projectId,
            type: trackingType,
            videoId: hasSingleVideo ? videoId : null,
            recipientEmail: recipient.email!,
          },
        })

        if (notifyEntireProject) {
          return sendProjectGeneralNotificationEmail({
            clientEmail: recipient.email!,
            clientName: recipient.name || 'Client',
            projectTitle: project.title,
            shareUrl,
            readyVideos: project.videos.map(v => ({ name: v.name, versionLabel: v.versionLabel, approved: v.approved })),
            readyAlbums,
            notes: trimmedNotes ? trimmedNotes : null,
            isPasswordProtected,
            trackingToken: trackingToken.token,
          })
        } else if (isSelectedItems) {
          return sendNewItemsReadyEmail({
            clientEmail: recipient.email!,
            clientName: recipient.name || 'Client',
            projectTitle: project.title,
            shareUrl,
            videos: selectedVideos,
            albums: selectedAlbums,
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
    const recipientsWithEmails = filteredRecipientsWithEmail

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

    // Queue password emails (if requested) as a delayed background job rather than blocking this
    // request with an in-process sleep. The worker staggers the password ~10s after the
    // notification email, survives a web-process restart, and logs send + open analytics.
    let passwordQueued = false
    if (sendPasswordSeparately && isPasswordProtected && project.sharePassword) {
      try {
        const passwordRecipientIds = filteredRecipientsWithEmail
          .map((r) => r.id)
          .filter((id): id is string => !!id)

        if (passwordRecipientIds.length > 0) {
          await getPasswordEmailQueue().add(
            'send-password-email',
            { projectId, recipientIds: passwordRecipientIds },
            { delay: 10_000 }
          )
          passwordQueued = true
        }
      } catch (error) {
        console.error('Failed to enqueue password emails:', error)
      }
    }

    if (successCount > 0) {
      // If we notify clients, move NOT_STARTED/IN_PROGRESS/REVIEWED → IN_REVIEW
      // (Display-only state; does not block auto-approval.)
      if ((project.status === 'NOT_STARTED' || project.status === 'IN_PROGRESS') || (!isInternalInvite && project.status === 'REVIEWED')) {
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
            videoId: hasSingleVideo ? videoId : null,
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
      if (passwordQueued) {
        message += ` The password will follow in a separate email shortly.`
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
