import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { deleteFile, deleteDirectory, moveDirectory } from '@/lib/storage'
import { requireApiAuth } from '@/lib/auth'
import { encrypt, decrypt } from '@/lib/encryption'
import { isSmtpConfigured, sendProjectApprovedEmail } from '@/lib/email'
import { invalidateProjectSessions, invalidateShareTokensByProject } from '@/lib/session-invalidation'
import { getProjectRecipients } from '@/lib/recipients'
import { getVideoQueue, getAlbumPhotoZipQueue } from '@/lib/queue'
import { getAlbumZipStoragePath, getAlbumZipJobId, AlbumZipVariant } from '@/lib/album-photo-zip'
import { sanitizeDropboxName, moveDropboxPath } from '@/lib/storage-provider-dropbox'
import {
  allocateUniqueStorageName,
  buildProjectDropboxRoot,
  buildProjectStorageRoot,
  getStoragePathBasename,
  replaceStoredStoragePathPrefix,
  replaceStoragePathPrefix,
} from '@/lib/project-storage-paths'
import { cancelProjectJobs, cancelProjectPreviewResolutionJobs } from '@/lib/cancel-project-jobs'
import { generateShareUrl } from '@/lib/url'
import { rateLimit } from '@/lib/rate-limit'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { getUserPermissions, isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { z } from 'zod'
export const runtime = 'nodejs'

const VALID_PREVIEW_RESOLUTIONS = ['480p', '720p', '1080p'] as const
type PreviewResolution = typeof VALID_PREVIEW_RESOLUTIONS[number]

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

function parsePreviewResolutions(raw: string | null | undefined): PreviewResolution[] {
  if (!raw) return ['720p']

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return ['720p']
    }

    const valid = parsed.filter(
      (resolution: unknown): resolution is PreviewResolution =>
        typeof resolution === 'string' &&
        (VALID_PREVIEW_RESOLUTIONS as readonly string[]).includes(resolution)
    )

    return valid.length > 0 ? valid : ['720p']
  } catch {
    if (typeof raw === 'string' && (VALID_PREVIEW_RESOLUTIONS as readonly string[]).includes(raw)) {
      return [raw as PreviewResolution]
    }
    return ['720p']
  }
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
  allowAuthenticatedProjectSwitching: z.boolean().optional(),
  maxClientUploadAllocationMB: z.number().int().min(0).max(1000000).optional(),
  previewResolution: z.enum(['480p', '720p', '1080p']).optional(),
  previewResolutions: z.array(z.enum(['480p', '720p', '1080p'])).min(1).optional(),
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
    const includeComments = new URL(request.url).searchParams.get('includeComments') !== 'false'

    const [project, commentAttachmentsCount, emailAttachmentsCount] = await Promise.all([
      prisma.project.findUnique({
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
          ...(includeComments
            ? {
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
              }
            : {}),
          recipients: {
            orderBy: [
              { isPrimary: 'desc' },
              { createdAt: 'asc' },
            ],
          },
        },
      }),
      prisma.commentFile.count({ where: { projectId: id } }),
      prisma.projectEmailAttachment.count({ where: { projectEmail: { projectId: id }, isInline: false } }),
    ])

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

    const globalSettings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { defaultAllowAuthenticatedProjectSwitching: true },
    })

    // Determine fallback name for sanitization
    const primaryRecipient = project.recipients?.find((r: any) => r.isPrimary) || project.recipients?.[0]
    const fallbackName = project.companyName || primaryRecipient?.name || 'Client'

    // Sanitize/normalize comments to ensure timecodes are consistent
    // Be defensive: malformed legacy comments should not break the entire project view.
    const sanitizedComments = includeComments
      ? (project.comments || []).map((comment: any) => {
          try {
            return sanitizeComment(comment, true, true, fallbackName)
          } catch {
            return comment
          }
        })
      : []

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
          eventType: { in: ['DOWNLOAD_COMPLETE', 'DOWNLOAD_SUCCEEDED'] },
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
      commentAttachmentsCount,
      emailAttachmentsCount,
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
      globalAllowAuthenticatedProjectSwitching: globalSettings?.defaultAllowAuthenticatedProjectSwitching ?? true,
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
    const canAccessExternalCommunication = canDoAction(permissions, 'projectExternalCommunication')

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

    if (!canAccessSharePage) {
      ;(projectData as any).commentAttachmentsCount = 0
    }

    if (!canAccessExternalCommunication) {
      ;(projectData as any).emailAttachmentsCount = 0
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
      select: {
        status: true,
        title: true,
        enableVideos: true,
        enablePhotos: true,
        previewResolutions: true,
        clientId: true,
        companyName: true,
        storagePath: true,
        client: { select: { name: true } },
      },
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
    const previousPreviewResolutions = parsePreviewResolutions(currentProject.previewResolutions)
    const nextPreviewResolutions = validatedBody.previewResolutions !== undefined
      ? validatedBody.previewResolutions
      : validatedBody.previewResolution !== undefined
        ? [validatedBody.previewResolution]
        : null

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

    const currentClientName = currentProject.client?.name || currentProject.companyName || 'Client'
    let targetClientId = currentProject.clientId
    let targetClientName = currentClientName

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
      targetClientId = client.id
      targetClientName = client.name
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
    if (validatedBody.allowAuthenticatedProjectSwitching !== undefined) {
      updateData.allowAuthenticatedProjectSwitching = validatedBody.allowAuthenticatedProjectSwitching
    }
    if (validatedBody.maxClientUploadAllocationMB !== undefined) {
      updateData.maxClientUploadAllocationMB = validatedBody.maxClientUploadAllocationMB
    }

    // Handle video processing settings
    if (validatedBody.previewResolutions !== undefined) {
      updateData.previewResolutions = JSON.stringify(validatedBody.previewResolutions)
    } else if (validatedBody.previewResolution !== undefined) {
      // Legacy single-value support
      updateData.previewResolutions = JSON.stringify([validatedBody.previewResolution])
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

        // Clear stored password when switching to a mode that doesn't use passwords
        if (validatedBody.authMode === 'OTP' || validatedBody.authMode === 'NONE') {
          if (validatedBody.sharePassword === undefined) {
            // Only clear if password wasn't explicitly provided in this request
            updateData.sharePassword = null
            passwordWasChanged = currentProject.sharePassword !== null
          }
        }
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

    const currentProjectStoragePath = currentProject.storagePath
      || buildProjectStorageRoot(currentClientName, currentProject.title)
    const currentProjectFolderName = getStoragePathBasename(currentProjectStoragePath) || currentProject.title
    const nextProjectTitle = validatedBody.title !== undefined ? validatedBody.title : currentProject.title

    let projectStorageRename:
      | {
          oldProjectStoragePath: string
          newProjectStoragePath: string
          oldProjectDropboxRoot: string
          newProjectDropboxRoot: string
        }
      | null = null

    if (
      validatedBody.title !== undefined
      || validatedBody.clientId !== undefined
      || !currentProject.storagePath
    ) {
      const siblingProjects = await prisma.project.findMany({
        where: {
          clientId: targetClientId,
          NOT: { id },
        },
        select: { storagePath: true, title: true },
      })
      const nextProjectFolderName = allocateUniqueStorageName(
        nextProjectTitle,
        siblingProjects
          .map((projectRow) => getStoragePathBasename(projectRow.storagePath) || projectRow.title)
          .filter(Boolean) as string[],
      )
      const nextProjectStoragePath = buildProjectStorageRoot(targetClientName, nextProjectFolderName)

      updateData.storagePath = nextProjectStoragePath

      if (nextProjectStoragePath !== currentProjectStoragePath) {
        projectStorageRename = {
          oldProjectStoragePath: currentProjectStoragePath,
          newProjectStoragePath: nextProjectStoragePath,
          oldProjectDropboxRoot: buildProjectDropboxRoot(currentClientName, currentProjectFolderName),
          newProjectDropboxRoot: buildProjectDropboxRoot(targetClientName, nextProjectFolderName),
        }
      }
    }

    // Snapshot existing assignments so we can detect newly added users after the transaction
    const previousAssignedUserIds = assignedUsersToSet !== null
      ? new Set(
          (await prisma.projectUser.findMany({ where: { projectId: id }, select: { userId: true } })).map((r) => r.userId)
        )
      : null

    let movedProjectStorage = false
    if (projectStorageRename && currentProject.storagePath) {
      await moveDirectory(projectStorageRename.oldProjectStoragePath, projectStorageRename.newProjectStoragePath)
      movedProjectStorage = true
    }

    // Update the project in database FIRST (before invalidating sessions)
    let project
    try {
      project = await prisma.$transaction(async (tx) => {
        const updated = await tx.project.update({
          where: { id },
          data: updateData,
        })

        if (projectStorageRename) {
          const videos = await tx.video.findMany({
            where: { projectId: id },
            select: {
              id: true,
              originalStoragePath: true,
              preview480Path: true,
              preview720Path: true,
              preview1080Path: true,
              thumbnailPath: true,
              timelinePreviewVttPath: true,
              timelinePreviewSpritesPath: true,
              dropboxPath: true,
            },
          })
          for (const video of videos) {
            await tx.video.update({
              where: { id: video.id },
              data: {
                originalStoragePath: replaceStoredStoragePathPrefix(
                  video.originalStoragePath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                )!,
                preview480Path: replaceStoredStoragePathPrefix(
                  video.preview480Path,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                ),
                preview720Path: replaceStoredStoragePathPrefix(
                  video.preview720Path,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                ),
                preview1080Path: replaceStoredStoragePathPrefix(
                  video.preview1080Path,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                ),
                thumbnailPath: replaceStoredStoragePathPrefix(
                  video.thumbnailPath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                ),
                timelinePreviewVttPath: replaceStoredStoragePathPrefix(
                  video.timelinePreviewVttPath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                ),
                timelinePreviewSpritesPath: replaceStoredStoragePathPrefix(
                  video.timelinePreviewSpritesPath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                ),
                dropboxPath: replaceStoragePathPrefix(
                  video.dropboxPath,
                  projectStorageRename.oldProjectDropboxRoot,
                  projectStorageRename.newProjectDropboxRoot,
                ),
              },
            })
          }

          const assets = await tx.videoAsset.findMany({
            where: { video: { projectId: id } },
            select: { id: true, storagePath: true, dropboxPath: true },
          })
          for (const asset of assets) {
            await tx.videoAsset.update({
              where: { id: asset.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(
                  asset.storagePath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                )!,
                dropboxPath: replaceStoragePathPrefix(
                  asset.dropboxPath,
                  projectStorageRename.oldProjectDropboxRoot,
                  projectStorageRename.newProjectDropboxRoot,
                ),
              },
            })
          }

          const albumPhotos = await tx.albumPhoto.findMany({
            where: { album: { projectId: id } },
            select: { id: true, storagePath: true, socialStoragePath: true },
          })
          for (const photo of albumPhotos) {
            await tx.albumPhoto.update({
              where: { id: photo.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(
                  photo.storagePath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                )!,
                socialStoragePath: replaceStoredStoragePathPrefix(
                  photo.socialStoragePath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                ),
              },
            })
          }

          const projectFiles = await tx.projectFile.findMany({
            where: { projectId: id },
            select: { id: true, storagePath: true },
          })
          for (const file of projectFiles) {
            await tx.projectFile.update({
              where: { id: file.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(
                  file.storagePath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                )!,
              },
            })
          }

          const projectEmails = await tx.projectEmail.findMany({
            where: { projectId: id },
            select: { id: true, rawStoragePath: true },
          })
          for (const email of projectEmails) {
            await tx.projectEmail.update({
              where: { id: email.id },
              data: {
                rawStoragePath: replaceStoredStoragePathPrefix(
                  email.rawStoragePath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                )!,
              },
            })
          }

          const attachments = await tx.projectEmailAttachment.findMany({
            where: { projectEmail: { projectId: id } },
            select: { id: true, storagePath: true },
          })
          for (const attachment of attachments) {
            await tx.projectEmailAttachment.update({
              where: { id: attachment.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(
                  attachment.storagePath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                )!,
              },
            })
          }

          const commentFiles = await tx.commentFile.findMany({
            where: { projectId: id },
            select: { id: true, storagePath: true },
          })
          for (const commentFile of commentFiles) {
            await tx.commentFile.update({
              where: { id: commentFile.id },
              data: {
                storagePath: replaceStoredStoragePathPrefix(
                  commentFile.storagePath,
                  projectStorageRename.oldProjectStoragePath,
                  projectStorageRename.newProjectStoragePath,
                )!,
              },
            })
          }

          const albums = await tx.album.findMany({
            where: { projectId: id },
            select: { id: true, fullZipDropboxPath: true, socialZipDropboxPath: true },
          })
          for (const album of albums) {
            await tx.album.update({
              where: { id: album.id },
              data: {
                fullZipDropboxPath: replaceStoragePathPrefix(
                  album.fullZipDropboxPath,
                  projectStorageRename.oldProjectDropboxRoot,
                  projectStorageRename.newProjectDropboxRoot,
                ),
                socialZipDropboxPath: replaceStoragePathPrefix(
                  album.socialZipDropboxPath,
                  projectStorageRename.oldProjectDropboxRoot,
                  projectStorageRename.newProjectDropboxRoot,
                ),
              },
            })
          }
        }

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
    } catch (error) {
      if (movedProjectStorage) {
        await moveDirectory(projectStorageRename!.newProjectStoragePath, projectStorageRename!.oldProjectStoragePath).catch(() => {})
      }
      throw error
    }

    if (nextPreviewResolutions !== null) {
      const removedPreviewResolutions = previousPreviewResolutions.filter(
        (resolution) => !nextPreviewResolutions.includes(resolution)
      )

      if (removedPreviewResolutions.length > 0) {
        await cancelProjectPreviewResolutionJobs(project.id, removedPreviewResolutions).catch((err) => {
          console.error('[PROJECT UPDATE] Error cancelling obsolete preview jobs after settings change:', err)
        })
      }
    }

    // Notify newly assigned users (in-app PROJECT_USER_ASSIGNED notification)
    if (assignedUsersToSet !== null && previousAssignedUserIds !== null) {
      const newlyAddedUserIds = assignedUsersToSet
        .filter((u) => !previousAssignedUserIds.has(u.userId) && u.userId !== admin.id)
        .map((u) => u.userId)

      if (newlyAddedUserIds.length > 0) {
        try {
          const usersToNotify = await prisma.user.findMany({
            where: { id: { in: newlyAddedUserIds } },
            select: { id: true, appRole: { select: { isSystemAdmin: true } } },
          })
          // Skip system admins — they have full project visibility anyway
          const filteredUsers = usersToNotify.filter((u) => u.appRole?.isSystemAdmin !== true)
          if (filteredUsers.length > 0) {
            await Promise.allSettled(
              filteredUsers.map((u) =>
                prisma.pushNotificationLog.create({
                  data: {
                    type: 'PROJECT_USER_ASSIGNED',
                    projectId: project.id,
                    success: true,
                    statusCode: null,
                    message: null,
                    details: {
                      __payload: {
                        title: 'Project Assignment',
                        message: `You have been added to "${project.title}"`,
                      },
                      __meta: {
                        targetUserId: u.id,
                        authorUserId: admin.id,
                      },
                    },
                  },
                })
              )
            )
          }
        } catch (err) {
          console.error('[PROJECT UPDATE] Failed to create assignment notification:', err)
        }
      }
    }

    if (
      projectStorageRename
      && projectStorageRename.oldProjectDropboxRoot !== projectStorageRename.newProjectDropboxRoot
    ) {
      void moveDropboxPath(
        projectStorageRename.oldProjectDropboxRoot,
        projectStorageRename.newProjectDropboxRoot,
      ).catch(() => {})
    }

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

    // Cancel pending jobs when project is closed
    if (validatedBody.status === 'CLOSED' && previousStatus !== 'CLOSED') {
      await cancelProjectJobs(project.id).catch((err) => {
        console.error('[PROJECT UPDATE] Error cancelling project jobs on close:', err)
      })
    }

    // Auto-delete previews and timeline sprites when project is closed (if setting enabled)
    if (validatedBody.status === 'CLOSED' && previousStatus !== 'CLOSED') {
      try {
        const globalSettings = await prisma.settings.findUnique({
          where: { id: 'default' },
          select: { autoDeletePreviewsOnClose: true },
        })
        if (globalSettings?.autoDeletePreviewsOnClose) {
          const videos = await prisma.video.findMany({
            where: { projectId: project.id },
            select: {
              id: true,
              preview480Path: true,
              preview720Path: true,
              preview1080Path: true,
              timelinePreviewSpritesPath: true,
              timelinePreviewsReady: true,
            },
          })
          for (const video of videos) {
            const previewPaths = [video.preview480Path, video.preview720Path, video.preview1080Path].filter(Boolean) as string[]
            const updateData: Record<string, null | boolean> = {}

            if (previewPaths.length > 0) {
              await Promise.allSettled(previewPaths.map(p => deleteFile(p)))
              updateData.preview480Path = null
              updateData.preview720Path = null
              updateData.preview1080Path = null
            }

            if (video.timelinePreviewSpritesPath) {
              await deleteDirectory(video.timelinePreviewSpritesPath).catch(() => {})
              updateData.timelinePreviewsReady = false
              updateData.timelinePreviewVttPath = null
              updateData.timelinePreviewSpritesPath = null
            }

            if (Object.keys(updateData).length > 0) {
              await prisma.video.update({
                where: { id: video.id },
                data: updateData,
              })
            }
          }
        }
      } catch (err) {
        console.error('[PROJECT UPDATE] Error auto-deleting previews/zips on close:', err)
      }
    }

    // Re-generate previews, timeline sprites, and album ZIPs when project is reopened from CLOSED
    if (previousStatus === 'CLOSED' && validatedBody.status !== undefined && validatedBody.status !== 'CLOSED') {
      try {
        // Check if any videos are missing previews (indicating they were auto-deleted)
        const videosNeedingPreviews = await prisma.video.findMany({
          where: {
            projectId: project.id,
            preview720Path: null,
            status: 'READY',
          },
          select: { id: true, originalStoragePath: true },
        })
        if (videosNeedingPreviews.length > 0) {
          const videoQueue = getVideoQueue()
          for (const video of videosNeedingPreviews) {
            await prisma.video.update({
              where: { id: video.id },
              data: { status: 'QUEUED', processingProgress: 0, processingPhase: null },
            })
            await videoQueue.add('process-video', {
              videoId: video.id,
              originalStoragePath: video.originalStoragePath!,
              projectId: project.id,
            })
          }
          console.log(`[PROJECT UPDATE] Re-queued ${videosNeedingPreviews.length} video(s) for preview regeneration after reopen`)
        }
      } catch (err) {
        console.error('[PROJECT UPDATE] Error re-queuing videos after reopen:', err)
      }

      // Re-generate album ZIPs if they were auto-deleted
      try {
        const albums = await prisma.album.findMany({
          where: {
            projectId: project.id,
            fullZipFileSize: { equals: 0 },
            socialZipFileSize: { equals: 0 },
            photos: { some: {} },
          },
          select: { id: true, socialCopiesEnabled: true },
        })
        if (albums.length > 0) {
          const q = getAlbumPhotoZipQueue()
          for (const album of albums) {
            const variants: AlbumZipVariant[] = album.socialCopiesEnabled ? ['full', 'social'] : ['full']
            for (const variant of variants) {
              const jobId = getAlbumZipJobId({ albumId: album.id, variant })
              await q.remove(jobId).catch(() => {})
              await q.add('generate-album-zip', { albumId: album.id, variant }, { jobId })
            }
          }
          console.log(`[PROJECT UPDATE] Re-queued ${albums.length} album(s) for ZIP regeneration after reopen`)
        }
      } catch (err) {
        console.error('[PROJECT UPDATE] Error re-queuing album ZIPs after reopen:', err)
      }
    }

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
    // Get project with all videos and their assets
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        client: { select: { name: true } },
        videos: {
          include: { assets: true },
        },
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
        // Delete asset files (including Dropbox copies)
        for (const asset of video.assets) {
          try {
            await deleteFile(asset.storagePath)
          } catch {
            // Ignore per-asset errors
          }
        }

        // Delete original file
        if (video.originalStoragePath) {
          await deleteFile(video.originalStoragePath)
        }

        // Delete preview files
        if (video.preview480Path) {
          await deleteFile(video.preview480Path)
        }
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
      await deleteDirectory(
        project.storagePath || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)
      )
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
