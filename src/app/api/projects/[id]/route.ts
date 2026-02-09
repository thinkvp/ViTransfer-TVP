import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { deleteFile, deleteDirectory } from '@/lib/storage'
import { requireApiAuth } from '@/lib/auth'
import { encrypt, decrypt } from '@/lib/encryption'
import { isSmtpConfigured, sendProjectApprovedEmail } from '@/lib/email'
import { invalidateProjectSessions, invalidateShareTokensByProject } from '@/lib/session-invalidation'
import { getProjectRecipients } from '@/lib/recipients'
import { generateShareUrl } from '@/lib/url'
import { rateLimit } from '@/lib/rate-limit'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { getUserPermissions, isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { z } from 'zod'
export const runtime = 'nodejs'

function asNumberBigInt(v: unknown): number {
  if (typeof v === 'bigint') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}




const updateProjectSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  clientId: z.string().regex(/^c[a-z0-9]{24}$/).optional(),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'REVIEWED', 'SHARE_ONLY', 'ON_HOLD', 'APPROVED', 'CLOSED']).optional(),
  enableRevisions: z.boolean().optional(),
  maxRevisions: z.number().int().min(0).max(50).optional(),
  restrictCommentsToLatestVersion: z.boolean().optional(),
  hideFeedback: z.boolean().optional(),
  useFullTimecode: z.boolean().optional(),
  allowClientDeleteComments: z.boolean().optional(),
  allowClientUploadFiles: z.boolean().optional(),
  maxClientUploadAllocationMB: z.number().int().min(0).max(1000000).optional(),
  previewResolution: z.enum(['720p', '1080p', '2160p']).optional(),
  watermarkEnabled: z.boolean().optional(),
  watermarkText: z.string().max(100).nullable().optional(),
  timelinePreviewsEnabled: z.boolean().optional(),
  sharePassword: z.string().max(200).nullable().optional(),
  authMode: z.enum(['PASSWORD', 'OTP', 'BOTH', 'NONE']).optional(),
  guestMode: z.boolean().optional(),
  guestLatestOnly: z.boolean().optional(),
  enableVideos: z.boolean().optional(),
  enablePhotos: z.boolean().optional(),
  clientNotificationSchedule: z.enum(['IMMEDIATE', 'HOURLY', 'DAILY', 'WEEKLY']).optional(),
  clientNotificationTime: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/).nullable().optional(),
  clientNotificationDay: z.number().int().min(0).max(6).nullable().optional(),
  assignedUserIds: z.array(z.string().regex(/^c[a-z0-9]{24}$/)).max(200).optional(),
  assignedUsers: z
    .array(
      z.object({
        userId: z.string().regex(/^c[a-z0-9]{24}$/),
        receiveNotifications: z.boolean().optional(),
      })
    )
    .max(200)
    .optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Check authentication
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  // Rate limiting: 60 requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.'
  }, 'project-read')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id } = await params

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            videos: true,
            albums: true,
          },
        },
        assignedUsers: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                displayColor: true,
                appRole: {
                  select: {
                    id: true,
                    name: true,
                    isSystemAdmin: true,
                    permissions: true,
                  },
                },
              },
            },
          },
        },
        videos: {
          orderBy: { version: 'desc' },
        },
        comments: {
          where: { parentId: null },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                username: true,
                email: true,
              }
            },
            replies: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    username: true,
                    email: true,
                  }
                }
              },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        recipients: {
          orderBy: [
            { isPrimary: 'desc' },
            { createdAt: 'asc' },
          ],
        },
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Non-system-admin users can only access projects explicitly assigned to them.
    if (authResult.appRoleIsSystemAdmin !== true) {
      const assignment = await prisma.projectUser.findUnique({
        where: {
          projectId_userId: {
            projectId: project.id,
            userId: authResult.id,
          },
        },
        select: { projectId: true },
      })
      if (!assignment) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
    }

    // Check SMTP configuration status
    const smtpConfigured = await isSmtpConfigured()

    // Determine fallback name for sanitization
    const primaryRecipient = project.recipients?.find((r: any) => r.isPrimary) || project.recipients?.[0]
    const fallbackName = project.companyName || primaryRecipient?.name || 'Client'

    // Sanitize/normalize comments to ensure timecodes are consistent
    // Be defensive: malformed legacy comments should not break the entire project view.
    const sanitizedComments = project.comments.map((comment: any) => {
      try {
        return sanitizeComment(comment, true, true, fallbackName)
      } catch {
        return comment
      }
    })

    // Decrypt password for admin users (needed for settings form)
    // Be defensive: if ENCRYPTION_KEY changed, older records may not decrypt.
    let decryptedPassword: string | null = null
    if (project.sharePassword) {
      try {
        decryptedPassword = decrypt(project.sharePassword)
      } catch (e) {
        console.error('[API] Failed to decrypt project sharePassword:', e)
        decryptedPassword = null
      }
    }

    const videoIds = project.videos.map((video) => video.id)
    const viewCountsByVideoId = new Map<string, number>()
    const downloadCountsByVideoId = new Map<string, number>()

    if (videoIds.length > 0) {
      const viewCounts = await prisma.videoAnalytics.groupBy({
        by: ['videoId'],
        where: {
          videoId: { in: videoIds },
          eventType: { in: ['VIDEO_VIEW', 'VIDEO_PLAY'] },
        },
        _count: { _all: true },
      })

      const downloadCounts = await prisma.videoAnalytics.groupBy({
        by: ['videoId'],
        where: {
          videoId: { in: videoIds },
          eventType: 'DOWNLOAD_COMPLETE',
        },
        _count: { _all: true },
      })

      for (const row of viewCounts) {
        viewCountsByVideoId.set(row.videoId, row._count._all)
      }

      for (const row of downloadCounts) {
        downloadCountsByVideoId.set(row.videoId, row._count._all)
      }
    }

    // Convert BigInt fields to strings for JSON serialization
    const projectData = {
      ...project,
      totalBytes: asNumberBigInt((project as any).totalBytes),
      diskBytes: (project as any).diskBytes == null ? null : asNumberBigInt((project as any).diskBytes),
      videos: project.videos.map((video: any) => ({
        ...video,
        originalFileSize: video.originalFileSize.toString(),
        viewCount: viewCountsByVideoId.get(video.id) ?? 0,
        downloadCount: downloadCountsByVideoId.get(video.id) ?? 0,
      })),
      comments: sanitizedComments,
      sharePassword: decryptedPassword,
      smtpConfigured,
      assignedUsers:
        (project as any).assignedUsers
          ?.map((pu: any) => {
            const user = pu.user || {}
            const role = user?.appRole || null
            const rolePermissions = normalizeRolePermissions(role?.permissions)
            const isAdminRole = role?.isSystemAdmin === true || (typeof role?.name === 'string' && role.name.trim().toLowerCase() === 'admin')
            return {
              id: user.id,
              name: user.name,
              email: user.email,
              displayColor: user.displayColor,
              appRole: role
                ? {
                    id: role.id,
                    name: role.name,
                    isSystemAdmin: role.isSystemAdmin,
                  }
                : null,
              canAccessSharePage: isAdminRole || canDoAction(rolePermissions, 'accessSharePage'),
              receiveNotifications: pu.receiveNotifications !== false,
            }
          })
          .filter((u: any) => u?.id) || [],
    }

    // Enforce simplified project/share permissions by stripping restricted sections.
    // (UI also hides these, but API should not leak them.)
    const permissions = getUserPermissions(authResult)
    const canFullControl = canDoAction(permissions, 'projectsFullControl')
    const canPhotoVideo = canDoAction(permissions, 'projectsPhotoVideoUploads')
    const canAccessSharePage = canDoAction(permissions, 'accessSharePage')

    if (!canAccessSharePage && !canPhotoVideo && !canFullControl) {
      ;(projectData as any).videos = []
      if ((projectData as any)?._count) {
        ;(projectData as any)._count = { ...(projectData as any)._count, videos: 0, albums: 0 }
      }
    }

    if (!canFullControl) {
      ;(projectData as any).sharePassword = null
      ;(projectData as any).recipients = []
      ;(projectData as any).assignedUsers = []
    }

    // External/share comments are only visible when the user can access the Share Page
    // (or has Photo & Video Uploads / Full Control).
    if (!canAccessSharePage && !canPhotoVideo && !canFullControl) {
      ;(projectData as any).comments = []
    }

    return NextResponse.json(projectData)
  } catch (error) {
    console.error('[API] Error fetching project:', error)
    return NextResponse.json(
      { error: 'Unable to process request' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Check authentication
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu
  const admin = authResult

  // Rate limiting: mutation throttle
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: 'Too many project update requests. Please slow down.',
  }, 'project-update')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params

    const currentProject = await prisma.project.findUnique({
      where: { id },
      select: { status: true },
    })
    if (!currentProject) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (!isVisibleProjectStatusForUser(authResult, currentProject.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Non-system-admin users can only mutate projects explicitly assigned to them.
    if (admin.appRoleIsSystemAdmin !== true) {
      const assignment = await prisma.projectUser.findUnique({
        where: {
          projectId_userId: {
            projectId: id,
            userId: admin.id,
          },
        },
        select: { projectId: true },
      })
      if (!assignment) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
    }

    const body = await request.json()
    const parsed = updateProjectSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const validatedBody = parsed.data

    // Assignment updates (optional)
    let assignedUsersToSet: Array<{ userId: string; receiveNotifications: boolean }> | null = null
    if (validatedBody.assignedUsers !== undefined || validatedBody.assignedUserIds !== undefined) {
      const requested: Array<{ userId: string; receiveNotifications: boolean }> =
        validatedBody.assignedUsers !== undefined
          ? Array.from(
              new Map(
                (validatedBody.assignedUsers || [])
                  .map((u) => ({
                    userId: String(u?.userId || ''),
                    receiveNotifications: u?.receiveNotifications !== false,
                  }))
                  .filter((u) => u.userId)
                  .map((u) => [u.userId, u])
              ).values()
            )
          : Array.isArray(validatedBody.assignedUserIds)
            ? Array.from(
                new Map(
                  validatedBody.assignedUserIds
                    .map((id) => String(id || ''))
                    .filter(Boolean)
                    .map((userId) => [userId, { userId, receiveNotifications: true }])
                ).values()
              )
            : []

      const creatorMustBeAssigned = admin.appRoleIsSystemAdmin !== true
      const effective = creatorMustBeAssigned
        ? Array.from(new Map([...requested, { userId: admin.id, receiveNotifications: true }].map((u) => [u.userId, u])).values())
        : requested

      if (effective.length === 0) {
        return NextResponse.json(
          { error: 'Each project must have at least one Admin assigned.' },
          { status: 400 }
        )
      } else {
        const rows = await prisma.user.findMany({
          where: { id: { in: effective.map((u) => u.userId) } },
          select: { id: true, appRole: { select: { isSystemAdmin: true, name: true, permissions: true } } },
        })

        const foundById = new Map(rows.map((r) => [r.id, r]))
        const missing = effective.filter((u) => !foundById.has(u.userId))
        if (missing.length > 0) {
          return NextResponse.json({ error: 'One or more assigned users were not found' }, { status: 400 })
        }

        const hasSystemAdmin = rows.some((r) => r.appRole?.isSystemAdmin === true)
        if (!hasSystemAdmin) {
          return NextResponse.json(
            { error: 'Each project must have at least one Admin assigned.' },
            { status: 400 }
          )
        }

        const shareAccessByUserId = new Map<string, { isAdminRole: boolean; canAccessSharePage: boolean }>(
          rows.map((r) => {
            const role = r.appRole
            const isAdminRole = role?.isSystemAdmin === true || (typeof role?.name === 'string' && role.name.trim().toLowerCase() === 'admin')
            const permissions = normalizeRolePermissions(role?.permissions)
            const canAccessSharePage = isAdminRole || canDoAction(permissions, 'accessSharePage')
            return [String(r.id), { isAdminRole, canAccessSharePage }] as const
          })
        )

        assignedUsersToSet = effective.map((u) => {
          const flags = shareAccessByUserId.get(u.userId)
          if (flags && !flags.isAdminRole && !flags.canAccessSharePage) {
            return { ...u, receiveNotifications: false }
          }
          return u
        })
      }
    }

    const isStatusMutation = validatedBody.status !== undefined
    const isSettingsMutation = Object.keys(validatedBody).some((k) => k !== 'status')

    if (isSettingsMutation) {
      const forbidden = requireActionAccess(authResult, 'changeProjectSettings')
      if (forbidden) return forbidden
    }
    if (isStatusMutation) {
      const forbidden = requireActionAccess(authResult, 'changeProjectStatuses')
      if (forbidden) return forbidden
    }

    // Track status transitions so we can trigger side effects (e.g. sending approval email)
    let previousStatus: string | null = null
    if (validatedBody.status !== undefined) {
      previousStatus = currentProject.status
    }

    // Build update data object
    const updateData: any = {}

    // Handle basic project details
    if (validatedBody.title !== undefined) {
      updateData.title = validatedBody.title
    }

    // Project Type flags
    if (validatedBody.enableVideos !== undefined) {
      const next = Boolean(validatedBody.enableVideos)
      if (!next) {
        const existingVideos = await prisma.video.count({ where: { projectId: id } })
        if (existingVideos > 0) {
          return NextResponse.json(
            { error: 'Remove existing videos to disable Videos in this project' },
            { status: 400 }
          )
        }
      }
      updateData.enableVideos = next
    }

    if (validatedBody.enablePhotos !== undefined) {
      const next = Boolean(validatedBody.enablePhotos)
      if (!next) {
        const existingAlbums = await prisma.album.count({ where: { projectId: id } })
        if (existingAlbums > 0) {
          return NextResponse.json(
            { error: 'Remove existing albums to disable Photos in this project' },
            { status: 400 }
          )
        }
      }
      updateData.enablePhotos = next
    }

    // Prevent invalid state where neither is enabled (accounting for current values)
    const finalEnableVideos = validatedBody.enableVideos !== undefined
      ? Boolean(validatedBody.enableVideos)
      : Boolean((currentProject as any).enableVideos ?? true)

    const finalEnablePhotos = validatedBody.enablePhotos !== undefined
      ? Boolean(validatedBody.enablePhotos)
      : Boolean((currentProject as any).enablePhotos ?? false)

    if (!finalEnableVideos && !finalEnablePhotos) {
      return NextResponse.json(
        { error: 'Project must have at least one type enabled (Video and/or Photo)' },
        { status: 400 }
      )
    }
    if (validatedBody.slug !== undefined) {
      // Check if slug is unique (excluding current project)
      const existingProject = await prisma.project.findFirst({
        where: {
          slug: validatedBody.slug,
          NOT: { id }
        }
      })
      
      if (existingProject) {
        return NextResponse.json(
          { error: 'This share link is already in use. Please choose a different one.' },
          { status: 409 }
        )
      }
      
      updateData.slug = validatedBody.slug
    }
    if (validatedBody.description !== undefined) {
      updateData.description = validatedBody.description || null
    }
    if (validatedBody.clientId !== undefined) {
      const client = await prisma.client.findFirst({
        where: { id: validatedBody.clientId, deletedAt: null },
        select: { id: true, name: true },
      })

      if (!client) {
        return NextResponse.json(
          { error: 'Client not found' },
          { status: 400 }
        )
      }

      updateData.clientId = client.id
      updateData.companyName = client.name
    }

    // Handle status update (for approval)
    if (validatedBody.status !== undefined) {
      updateData.status = validatedBody.status

      // When approving project, just set the status and timestamp
      // Video approvals are handled separately by the admin
      if (validatedBody.status === 'APPROVED') {
        updateData.approvedAt = new Date()
      }

      // When changing status away from APPROVED, clear approval metadata
      if (validatedBody.status !== 'APPROVED') {
        updateData.approvedAt = null
      }
    }

    // Handle revision settings
    if (validatedBody.enableRevisions !== undefined) {
      updateData.enableRevisions = validatedBody.enableRevisions
    }
    if (validatedBody.maxRevisions !== undefined) {
      updateData.maxRevisions = validatedBody.maxRevisions
    }

    // Handle comment restrictions
    if (validatedBody.restrictCommentsToLatestVersion !== undefined) {
      updateData.restrictCommentsToLatestVersion = validatedBody.restrictCommentsToLatestVersion
    }
    if (validatedBody.hideFeedback !== undefined) {
      updateData.hideFeedback = validatedBody.hideFeedback
    }
    if (validatedBody.useFullTimecode !== undefined) {
      updateData.useFullTimecode = validatedBody.useFullTimecode
    }
    if (validatedBody.allowClientDeleteComments !== undefined) {
      updateData.allowClientDeleteComments = validatedBody.allowClientDeleteComments
    }
    if (validatedBody.allowClientUploadFiles !== undefined) {
      updateData.allowClientUploadFiles = validatedBody.allowClientUploadFiles
    }
    if (validatedBody.maxClientUploadAllocationMB !== undefined) {
      updateData.maxClientUploadAllocationMB = validatedBody.maxClientUploadAllocationMB
    }

    // Handle video processing settings
    if (validatedBody.previewResolution !== undefined) {
      updateData.previewResolution = validatedBody.previewResolution
    }

    if (validatedBody.timelinePreviewsEnabled !== undefined) {
      updateData.timelinePreviewsEnabled = validatedBody.timelinePreviewsEnabled
    }

    if (validatedBody.watermarkEnabled !== undefined) {
      updateData.watermarkEnabled = validatedBody.watermarkEnabled
    }

    if (validatedBody.watermarkText !== undefined) {
      // SECURITY: Validate watermark text (same rules as FFmpeg sanitization)
      // Only allow alphanumeric, spaces, and safe punctuation: - _ . ( )
      if (validatedBody.watermarkText) {
        const invalidChars = validatedBody.watermarkText.match(/[^a-zA-Z0-9\s\-_.()]/g)
        if (invalidChars) {
          const uniqueInvalid = [...new Set(invalidChars)].join(', ')
          return NextResponse.json(
            {
              error: 'Invalid characters in watermark text',
              details: `Watermark text contains invalid characters: ${uniqueInvalid}. Only letters, numbers, spaces, and these characters are allowed: - _ . ( )`
            },
            { status: 400 }
          )
        }

        // Additional length check (prevent excessively long watermarks)
        if (validatedBody.watermarkText.length > 100) {
          return NextResponse.json(
            {
              error: 'Watermark text too long',
              details: 'Watermark text must be 100 characters or less'
            },
            { status: 400 }
          )
        }
      }

      updateData.watermarkText = validatedBody.watermarkText || null
    }

    // Handle password, authMode, and guest settings updates
    // Fetch current project once if any security field is being updated
    let passwordWasChanged = false
    let authModeWasChanged = false
    let guestModeWasChanged = false
    let guestLatestOnlyWasChanged = false

    if (validatedBody.sharePassword !== undefined || validatedBody.authMode !== undefined || validatedBody.guestMode !== undefined || validatedBody.guestLatestOnly !== undefined) {
      // Get current project state (single query for all security checks)
      const currentProject = await prisma.project.findUnique({
        where: { id },
        select: { authMode: true, sharePassword: true, guestMode: true, guestLatestOnly: true }
      })

      if (!currentProject) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }

      // Handle password update - only update if actually changed
      if (validatedBody.sharePassword !== undefined) {
        // Decrypt current password for comparison
        const currentPassword = currentProject.sharePassword ? decrypt(currentProject.sharePassword) : null

        // Only update if password actually changed
        if (validatedBody.sharePassword === null || validatedBody.sharePassword === '') {
          // Clearing password
          if (currentPassword !== null) {
            updateData.sharePassword = null
            passwordWasChanged = true
          }
        } else {
          // Setting/updating password - only if different from current
          if (validatedBody.sharePassword !== currentPassword) {
            updateData.sharePassword = encrypt(validatedBody.sharePassword)
            passwordWasChanged = true
          }
        }
      }

      // Handle authentication mode
      if (validatedBody.authMode !== undefined) {
        // Detect if authMode actually changed
        if (currentProject.authMode !== validatedBody.authMode) {
          authModeWasChanged = true
        }

        // Validate that password modes have a password when being set
        const newAuthMode = validatedBody.authMode
        const newPassword = validatedBody.sharePassword !== undefined ? validatedBody.sharePassword : undefined

        // Get current password if not being changed
        if (newPassword === undefined && (newAuthMode === 'PASSWORD' || newAuthMode === 'BOTH')) {
          const currentPassword = currentProject?.sharePassword ? decrypt(currentProject.sharePassword) : null

          if (!currentPassword) {
            return NextResponse.json(
              { error: 'Password authentication mode requires a password' },
              { status: 400 }
            )
          }
        } else if ((newAuthMode === 'PASSWORD' || newAuthMode === 'BOTH') && (!newPassword || newPassword === '')) {
          return NextResponse.json(
            { error: 'Password authentication mode requires a password' },
            { status: 400 }
          )
        }

        updateData.authMode = validatedBody.authMode
      }

      // Handle guest mode
      if (validatedBody.guestMode !== undefined) {
        // Detect if guestMode actually changed
        if (currentProject.guestMode !== validatedBody.guestMode) {
          guestModeWasChanged = true
        }
        updateData.guestMode = validatedBody.guestMode
      }

      // Handle guest latest only restriction
      if (validatedBody.guestLatestOnly !== undefined) {
        // Detect if guestLatestOnly actually changed
        if (currentProject.guestLatestOnly !== validatedBody.guestLatestOnly) {
          guestLatestOnlyWasChanged = true
        }
        updateData.guestLatestOnly = validatedBody.guestLatestOnly
      }
    }

    // Separate validation when only password is being cleared without authMode change
    if (validatedBody.sharePassword !== undefined && validatedBody.authMode === undefined) {
      const currentProject = await prisma.project.findUnique({
        where: { id },
        select: { authMode: true }
      })

      if ((currentProject?.authMode === 'PASSWORD' || currentProject?.authMode === 'BOTH') &&
          (validatedBody.sharePassword === null || validatedBody.sharePassword === '')) {
        return NextResponse.json(
          { error: 'Cannot remove password when using password authentication mode. Switch to "No Authentication" first.' },
          { status: 400 }
        )
      }
    }

    // Handle client notification schedule
    if (validatedBody.clientNotificationSchedule !== undefined) {
      updateData.clientNotificationSchedule = validatedBody.clientNotificationSchedule
    }
    if (validatedBody.clientNotificationTime !== undefined) {
      updateData.clientNotificationTime = validatedBody.clientNotificationTime
    }
    if (validatedBody.clientNotificationDay !== undefined) {
      updateData.clientNotificationDay = validatedBody.clientNotificationDay
    }

    // Update the project in database FIRST (before invalidating sessions)
    const project = await prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id },
        data: updateData,
      })

      if (assignedUsersToSet !== null) {
        await tx.projectUser.deleteMany({ where: { projectId: id } })
        if (assignedUsersToSet.length > 0) {
          await tx.projectUser.createMany({
            data: assignedUsersToSet.map((a) => ({
              projectId: id,
              userId: a.userId,
              receiveNotifications: a.receiveNotifications !== false,
            })),
            skipDuplicates: true,
          })
        }
      }

      return updated
    })

    // Record status change in analytics activity feed
    if (validatedBody.status !== undefined && previousStatus && previousStatus !== validatedBody.status) {
      await prisma.projectStatusChange.create({
        data: {
          projectId: project.id,
          previousStatus: previousStatus as any,
          currentStatus: validatedBody.status as any,
            source: 'ADMIN',
          changedById: admin.id,
        },
      })
    }

    // NOTE: Project status changes no longer move storage folders.

    // When an admin manually marks a project APPROVED, send the Project Approved email immediately.
    // (Client-driven approvals have their own notification path in /api/projects/[id]/approve.)
    if (validatedBody.status === 'APPROVED' && previousStatus !== 'APPROVED') {
      try {
        const smtpConfigured = await isSmtpConfigured()
        if (!smtpConfigured) {
          console.log('[PROJECT UPDATE] SMTP not configured; skipping Project Approved email')
        } else {
          const allRecipients = await getProjectRecipients(project.id)
          const recipients = allRecipients.filter((r) => r.receiveNotifications && r.email)

          if (recipients.length === 0) {
            console.log('[PROJECT UPDATE] No recipients opted in; skipping Project Approved email')
          } else {
            const shareUrl = await generateShareUrl(project.slug)
            const approvedVideos = await prisma.video.findMany({
              where: { projectId: project.id, approved: true },
              select: { id: true, name: true },
            })

            const settings = await prisma.settings.findUnique({
              where: { id: 'default' },
              select: {
                autoCloseApprovedProjectsEnabled: true,
                autoCloseApprovedProjectsAfterDays: true,
              },
            })

            let autoCloseInfo: { closeDate: Date; days: number } | null = null
            if (settings?.autoCloseApprovedProjectsEnabled) {
              const days = settings.autoCloseApprovedProjectsAfterDays
              if (Number.isInteger(days) && days > 0) {
                const base = project.approvedAt || new Date()
                const closeDate = new Date(base)
                closeDate.setDate(closeDate.getDate() + days)
                autoCloseInfo = { closeDate, days }
              }
            }

            console.log(`[PROJECT UPDATE] Sending Project Approved email to ${recipients.length} recipient(s)`) 

            const results = await Promise.allSettled(
              recipients.map((recipient) =>
                sendProjectApprovedEmail({
                  clientEmail: recipient.email!,
                  clientName: recipient.name || 'Client',
                  projectTitle: project.title,
                  shareUrl,
                  approvedVideos,
                  isComplete: true,
                  autoCloseInfo,
                })
              )
            )

            const failures = results.filter(
              (r) => r.status === 'fulfilled' && r.value && (r.value as any).success === false
            ).length
            console.log(
              `[PROJECT UPDATE] Project Approved emails attempted=${recipients.length} failures=${failures}`
            )
          }
        }
      } catch (error) {
        console.error('[PROJECT UPDATE] Failed sending Project Approved email:', error)
      }
    }

    // SECURITY: After password, authMode, guestMode, or guestLatestOnly is updated in DB, invalidate ALL sessions for this project
    // This prevents clients from using old authentication/authorization even though security rules changed
    if (passwordWasChanged || authModeWasChanged || guestModeWasChanged || guestLatestOnlyWasChanged) {
      try {
        // Invalidate JWT-based share sessions
        const shareSessionsInvalidated = await invalidateShareTokensByProject(id)

        // Also invalidate any legacy Redis sessions
        const legacySessionsInvalidated = await invalidateProjectSessions(id)

        // Log the security action
        const changes: string[] = []
        if (passwordWasChanged) changes.push('password')
        if (authModeWasChanged) changes.push('auth mode')
        if (guestModeWasChanged) changes.push('guest mode')
        if (guestLatestOnlyWasChanged) changes.push('guest latest only')
        const changeReason = changes.join(' and ') + ' changed'

        console.log(
          `[SECURITY] Project ${changeReason} - invalidated ${shareSessionsInvalidated} share sessions ` +
          `and ${legacySessionsInvalidated} legacy sessions for project ${id}`
        )
      } catch (error) {
        console.error('[SECURITY] Failed to invalidate project sessions after security change:', error)
        // Don't fail the request if session invalidation fails - security change is more important
      }

    }

    return NextResponse.json({
      ...project,
      totalBytes: asNumberBigInt((project as any).totalBytes),
      diskBytes: (project as any).diskBytes == null ? null : asNumberBigInt((project as any).diskBytes),
    })
  } catch (error) {
    console.error('[API] Error updating project:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'deleteProjects')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many project delete requests. Please slow down.',
  }, 'project-delete')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    // Get project with all videos
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        videos: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Delete all video files from storage
    for (const video of project.videos) {
      try {
        // Delete original file
        if (video.originalStoragePath) {
          await deleteFile(video.originalStoragePath)
        }

        // Delete preview files
        if (video.preview1080Path) {
          await deleteFile(video.preview1080Path)
        }
        if (video.preview720Path) {
          await deleteFile(video.preview720Path)
        }

        // Delete thumbnail
        if (video.thumbnailPath) {
          await deleteFile(video.thumbnailPath)
        }
      } catch (error) {
        console.error(`Failed to delete files for video ${video.id}:`, error)
        // Continue deleting other files even if one fails
      }
    }

    // Delete the entire project directory after all files are removed
    try {
      await deleteDirectory(`projects/${id}`)
    } catch (error) {
      console.error(`Failed to delete project directory for ${id}:`, error)
      // Continue even if directory deletion fails
    }

    // SECURITY: Invalidate all sessions for this project before deletion
    try {
      const invalidatedCount = await invalidateProjectSessions(id)
      console.log(`[SECURITY] Project deleted - invalidated ${invalidatedCount} sessions`)
    } catch (error) {
      console.error('[SECURITY] Failed to invalidate sessions during project deletion:', error)
      // Continue with deletion even if session invalidation fails
    }

    // Delete project and all related data (cascade will handle videos, comments, shares)
    await prisma.project.delete({
      where: { id: id },
    })

    return NextResponse.json({
      success: true,
      message: 'Project and all related files deleted successfully'
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Operation failed' },
      { status: 500 }
    )
  }
}
