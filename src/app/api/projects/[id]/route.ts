import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { deleteFile, deleteDirectory, moveDirectory } from '@/lib/storage'
import { getStoredPathsForEntities, deleteStoredFilesByCriteria, getStoredFileRecords, deleteStoredFilesForProject } from '@/lib/stored-file'
import type { FileRole } from '@/lib/stored-file'
import { requireApiAuth } from '@/lib/auth'
import { encrypt, decrypt } from '@/lib/encryption'
import { isSmtpConfigured, sendProjectApprovedEmail } from '@/lib/email'
import { invalidateProjectSessions, invalidateShareTokensByProject } from '@/lib/session-invalidation'
import { getProjectRecipients } from '@/lib/recipients'
import { enqueueShareUploadPreview, getVideoQueue, getAlbumPhotoZipQueue } from '@/lib/queue'
import { publishProjectEvent } from '@/lib/project-events'
import { getAlbumZipStoragePath, getAlbumZipJobId, AlbumZipVariant } from '@/lib/album-photo-zip'
import { isS3Mode } from '@/lib/s3-storage'
import {
  allocateUniqueStorageName,
  buildPreviewsRoot,
  buildProjectStorageRoot,
  buildVideoHlsStorageRoot,
  getStoragePathBasename,
  replaceStoredStoragePathPrefix,
} from '@/lib/project-storage-paths'
import { HLS_PACKAGE_VERSION } from '@/lib/video-stream-url'
import { cancelProjectJobs, cancelProjectPreviewResolutionJobs } from '@/lib/cancel-project-jobs'
import { recalculateAndStoreProjectDiskBytes, recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { asNumberBigInt } from '@/lib/utils'
import { generateShareUrl } from '@/lib/url'
import { rateLimit } from '@/lib/rate-limit'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { getUserPermissions, isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { isStartDateDue, parseProjectStartDateInput } from '@/lib/project-start-date'
import { sendPushNotification } from '@/lib/push-notifications'
import { z } from 'zod'
export const runtime = 'nodejs'

const VALID_PREVIEW_RESOLUTIONS = ['480p', '720p', '1080p'] as const
type PreviewResolution = typeof VALID_PREVIEW_RESOLUTIONS[number]

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

function isPreviewableMediaFileType(fileType: string | null | undefined): boolean {
  const normalized = String(fileType || '').toLowerCase()
  return normalized.startsWith('image/') || normalized.startsWith('video/')
}




const updateProjectSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  clientId: z.string().regex(/^c[a-z0-9]{24}$/).optional(),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'REVIEWED', 'ON_HOLD', 'APPROVED', 'CLOSED']).optional(),
  restrictCommentsToLatestVersion: z.boolean().optional(),
  hideFeedback: z.boolean().optional(),
  useFullTimecode: z.boolean().optional(),
  allowClientDeleteComments: z.boolean().optional(),
  enableClientUploads: z.boolean().optional(),
  allowClientUploadFiles: z.boolean().optional(),
  allowAuthenticatedProjectSwitching: z.boolean().optional(),
  maxClientUploadAllocationMB: z.number().int().min(0).max(1000000).optional(),
  previewResolution: z.enum(['480p', '720p', '1080p']).optional(),
  previewResolutions: z.array(z.enum(['480p', '720p', '1080p'])).min(1).optional(),
  sharePassword: z.string().max(200).nullable().optional(),
  authMode: z.enum(['PASSWORD', 'OTP', 'BOTH', 'NONE']).optional(),
  enableVideos: z.boolean().optional(),
  enablePhotos: z.boolean().optional(),
  enableUploads: z.boolean().optional(),
  clientNotificationSchedule: z.enum(['IMMEDIATE', 'HOURLY', 'DAILY', 'NONE']).optional(),
  clientNotificationTime: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/).nullable().optional(),
  clientNotificationDay: z.number().int().min(0).max(6).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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
              shareUploadFiles: true,
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
      previewBytes: asNumberBigInt((project as any).previewBytes),
      diskBytes: (project as any).diskBytes == null ? null : asNumberBigInt((project as any).diskBytes),
      videos: await Promise.all(project.videos.map(async (video: any) => {
        const [origFile, previews] = await Promise.all([
          getStoredFileRecords('VIDEO', [video.id], { fileRoles: ['ORIGINAL'], select: { fileSize: true, fileName: true } }).then(r => r[0] ?? null),
          getStoredFileRecords('VIDEO', [video.id], { fileRoles: ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL', 'ORIGINAL', 'SUBTITLES_VTT', 'WAVEFORM_PEAKS'], select: { fileRole: true, updatedAt: true } }),
        ])
        const previewSet = new Set(previews.map(p => p.fileRole))
        const thumbnailRow = previews.find(p => p.fileRole === 'THUMBNAIL')
        return {
          ...video,
          originalFileSize: (origFile?.fileSize ?? BigInt(0)).toString(),
          originalFileName: origFile?.fileName ?? video.name ?? '',
          viewCount: viewCountsByVideoId.get(video.id) ?? 0,
          downloadCount: downloadCountsByVideoId.get(video.id) ?? 0,
          hasThumbnail: previewSet.has('THUMBNAIL'),
          thumbnailPath: previewSet.has('THUMBNAIL'),      // boolean for admin share page
          // Freshness signal so admin poster caches re-mint when the thumbnail is
          // swapped (custom set/unset) — the booleans above don't change then.
          thumbnailUpdatedAt: thumbnailRow?.updatedAt?.toISOString?.() ?? null,
          preview480Path: previewSet.has('PREVIEW_480'),     // boolean for admin share page
          preview720Path: previewSet.has('PREVIEW_720'),
          preview1080Path: previewSet.has('PREVIEW_1080'),
          originalStoragePath: previewSet.has('ORIGINAL'),   // boolean for admin share page
          hasSubtitles: previewSet.has('SUBTITLES_VTT'),
          hasWaveformPeaks: previewSet.has('WAVEFORM_PEAKS'),
        }
      })),
      comments: sanitizedComments,
      sharePassword: decryptedPassword,
      smtpConfigured,
      // HLS is only packaged in S3 mode (delivered direct-from-R2); the admin UI uses this
      // to decide whether to show per-video HLS-readiness state at all.
      s3Mode: isS3Mode(),
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
        startDate: true,
        createdAt: true,
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
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
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

    if (validatedBody.enableUploads !== undefined) {
      const next = Boolean(validatedBody.enableUploads)
      if (!next) {
        const existingUploads = await prisma.shareUploadFile.count({ where: { projectId: id } })
        if (existingUploads > 0) {
          return NextResponse.json(
            { error: 'Remove existing uploaded files to disable Uploads in this project' },
            { status: 400 }
          )
        }
      }
      updateData.enableUploads = next
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
    if (validatedBody.enableClientUploads !== undefined) {
      updateData.enableClientUploads = validatedBody.enableClientUploads
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

    // Handle password and authMode settings updates
    // Fetch current project once if any security field is being updated
    let passwordWasChanged = false
    let authModeWasChanged = false

    if (validatedBody.sharePassword !== undefined || validatedBody.authMode !== undefined) {
      // Get current project state (single query for all security checks)
      const currentProject = await prisma.project.findUnique({
        where: { id },
        select: { authMode: true, sharePassword: true }
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

    // Handle startDate
    if (validatedBody.startDate !== undefined) {
      if (validatedBody.startDate === null) {
        updateData.startDate = null
      } else {
        const parsed = parseProjectStartDateInput(validatedBody.startDate)
        if (!parsed) {
          return NextResponse.json({ error: 'Invalid start date format (expected YYYY-MM-DD)' }, { status: 400 })
        }
        updateData.startDate = parsed
      }

      // Auto-promote NOT_STARTED → IN_PROGRESS if start date is due and no explicit status change
      if (validatedBody.status === undefined && currentProject.status === 'NOT_STARTED') {
        const effectiveStart = updateData.startDate ?? currentProject.startDate
        if (effectiveStart && isStartDateDue(effectiveStart, currentProject.createdAt)) {
          updateData.status = 'IN_PROGRESS'
          previousStatus = currentProject.status
        }
      }
    }

    const currentProjectStoragePath = currentProject.storagePath
      || buildProjectStorageRoot(currentClientName, currentProject.title)
    const currentProjectFolderName = getStoragePathBasename(currentProjectStoragePath) || currentProject.title
    const nextProjectTitle = validatedBody.title !== undefined ? validatedBody.title : currentProject.title

    let projectStorageRename:
      | {
          oldProjectStoragePath: string
          newProjectStoragePath: string
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
        }
      }
    }

    // Snapshot existing assignments so we can detect newly added users after the transaction
    const previousAssignedUserIds = assignedUsersToSet !== null
      ? new Set(
          (await prisma.projectUser.findMany({ where: { projectId: id }, select: { userId: true } })).map((r) => r.userId)
        )
      : null

    // In S3 mode, a folder rename is a heavy background operation (copy + delete).
    // Return 202 to tell the client to show the confirmation modal instead of
    // doing the move inline.
    if (projectStorageRename && isS3Mode()) {
      // Check for an in-progress rename job first.
      const activeRenameJob = await prisma.folderRenameJob.findFirst({
        where: { entityType: 'PROJECT', entityId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
        select: { oldPrefix: true, newPrefix: true },
      })

      if (activeRenameJob) {
        const sameRenameAlreadyScheduled =
          activeRenameJob.oldPrefix === projectStorageRename.oldProjectStoragePath
          && activeRenameJob.newPrefix === projectStorageRename.newProjectStoragePath

        if (!sameRenameAlreadyScheduled) {
          return NextResponse.json(
            { error: 'A folder rename is already in progress for this project. Please wait for it to complete.' },
            { status: 423 },
          )
        }

        // A matching rename is already queued/running (e.g. after rename-confirm).
        // Keep legacy storagePath until worker completion, but allow other settings to save.
        delete updateData.storagePath
        projectStorageRename = null
      }

      if (projectStorageRename) {
        return NextResponse.json(
          {
            requiresJobConfirmation: true,
            proposedTitle: nextProjectTitle,
            oldStoragePath: projectStorageRename.oldProjectStoragePath,
            newStoragePath: projectStorageRename.newProjectStoragePath,
          },
          { status: 202 },
        )
      }
    }

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
            select: { id: true },
          })
          // Video/VideoAsset path columns dropped — StoredFile handles path rebasing
          // via renameStoredPaths() called by the folder-rename-processor
          for (const video of videos) {
            // No per-column updates needed — paths are in StoredFile
          }
          // Asset/Photo/File path columns dropped — StoredFile handles path rebasing
        }

        return updated
      })

      if (nextPreviewResolutions !== null) {
      const removedPreviewResolutions = previousPreviewResolutions.filter(
        (resolution) => !nextPreviewResolutions.includes(resolution)
      )

      if (removedPreviewResolutions.length > 0) {
        await cancelProjectPreviewResolutionJobs(project.id, removedPreviewResolutions).catch((err) => {
          console.error('[PROJECT UPDATE] Error cancelling obsolete preview jobs after settings change:', err)
        })

        // Reclaim storage: delete the removed resolution's previews (MP4 + HLS) for every
        // video in the project, rather than leaving orphaned renditions behind. (Re-adding
        // the resolution later will re-encode it.)
        try {
          const resolutionToRole: Record<PreviewResolution, FileRole> = {
            '480p': 'PREVIEW_480',
            '720p': 'PREVIEW_720',
            '1080p': 'PREVIEW_1080',
          }
          const removedRoles = removedPreviewResolutions.map((r) => resolutionToRole[r])

          const projectVideos = await prisma.video.findMany({
            where: { projectId: project.id },
            select: { id: true, hlsReady: true, hlsVersion: true },
          })
          const videoIds = projectVideos.map((v) => v.id)

          if (videoIds.length > 0) {
            // 1) Drop the removed-resolution MP4 preview files + their StoredFile rows.
            const removedStored = await getStoredFileRecords('VIDEO', videoIds, {
              fileRoles: removedRoles,
              select: { storagePath: true },
            })
            await Promise.allSettled(removedStored.map((f) => deleteFile(f.storagePath).catch(() => {})))
            await deleteStoredFilesByCriteria({ entityType: 'VIDEO', entityIds: videoIds, fileRoles: removedRoles })

            // 2) Make HLS match. For ABR-ready (keyframe-aligned) bundles, repackage from the
            //    remaining previews — a cheap `-c copy` remux (the packager wipes hls/ first),
            //    so the master drops the removed rendition. For legacy non-aligned bundles,
            //    just delete the bundle: repackaging would falsely stamp it ABR-ready, and it
            //    rebuilds correctly on the next full reprocess.
            const videoQueue = getVideoQueue()
            for (const v of projectVideos) {
              if (!v.hlsReady) continue
              if (v.hlsVersion >= HLS_PACKAGE_VERSION) {
                await videoQueue.add('process-video', { videoId: v.id, projectId: project.id, storagePath: '', hlsOnly: true }).catch(() => {})
              } else {
                await deleteDirectory(buildVideoHlsStorageRoot(project.id, v.id)).catch(() => {})
                await deleteStoredFilesByCriteria({ entityType: 'VIDEO', entityIds: [v.id], fileRoles: ['HLS_PLAYLIST', 'HLS_SEGMENTS'] })
                await prisma.video.update({ where: { id: v.id }, data: { hlsReady: false, hlsVersion: 0 } }).catch(() => {})
              }
            }

            // Refresh precomputed storage totals so the dashboard reflects the freed space now.
            await Promise.allSettled([
              recalculateAndStoreProjectTotalBytes(project.id),
              recalculateAndStoreProjectPreviewBytes(project.id),
              recalculateAndStoreProjectDiskBytes(project.id),
            ])
          }
        } catch (err) {
          console.error('[PROJECT UPDATE] Error deleting previews for removed resolutions:', err)
        }
      }
    }
    } catch (error) {
      if (movedProjectStorage && projectStorageRename) {
        await moveDirectory(projectStorageRename.newProjectStoragePath, projectStorageRename.oldProjectStoragePath).catch(() => {})
      }
      throw error
    }

    // Notify newly assigned users (in-app PROJECT_USER_ASSIGNED notification)
    if (assignedUsersToSet !== null && previousAssignedUserIds !== null) {
      const newAssignedUserIdSet = new Set(assignedUsersToSet.map((u) => u.userId))
      const newlyAddedUserIds = assignedUsersToSet
        .filter((u) => !previousAssignedUserIds.has(u.userId) && u.userId !== admin.id)
        .map((u) => u.userId)

      const removedFromProjectIds = [...previousAssignedUserIds].filter((uid) => !newAssignedUserIdSet.has(uid))

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
              filteredUsers.map(async (u) => {
                await sendPushNotification({
                  type: 'PROJECT_USER_ASSIGNED',
                  title: 'Project Assignment',
                  message: `You have been added to Project: "${project.title}"`,
                  projectId: project.id,
                  projectName: project.title,
                  details: {
                    __controls: { pinned: true, clearable: true, manualClearRequired: true },
                    __meta: {
                      targetUserId: u.id,
                      authorUserId: admin.id,
                      projectTitle: project.title,
                    },
                  },
                }).catch(() => {})
              })
            )
          }
        } catch (err) {
          console.error('[PROJECT UPDATE] Failed to create assignment notification:', err)
        }
      }

      // Auto-clear pending PROJECT_USER_ASSIGNED notifications for removed users
      if (removedFromProjectIds.length > 0) {
        await Promise.allSettled(
          removedFromProjectIds.map((uid) =>
            prisma.pushNotificationLog.deleteMany({
              where: {
                type: 'PROJECT_USER_ASSIGNED',
                projectId: project.id,
                AND: [
                  { details: { path: ['__meta', 'targetUserId'], equals: uid } },
                ],
              },
            })
          )
        ).catch(() => {})
      }
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

      // Notify open share pages / admin dashboards so the status badge updates live.
      await publishProjectEvent(project.id, 'status')

      // Clear PROJECT_USER_ASSIGNED notifications for users who can no longer see the new status.
      // A user is "blinded" when their role's projectVisibility doesn't include the new status.
      try {
        const assignedUsers = await prisma.projectUser.findMany({
          where: { projectId: project.id },
          select: {
            userId: true,
            user: { select: { appRole: { select: { permissions: true, isSystemAdmin: true } } } },
          },
        })
        const blindedUserIds = assignedUsers
          .filter((pu) => {
            if (pu.user?.appRole?.isSystemAdmin) return false
            const perms = normalizeRolePermissions(pu.user?.appRole?.permissions)
            return !perms.projectVisibility.statuses.includes(validatedBody.status as any)
          })
          .map((pu) => pu.userId)
        if (blindedUserIds.length > 0) {
          await Promise.allSettled(
            blindedUserIds.map((uid) =>
              prisma.pushNotificationLog.deleteMany({
                where: {
                  type: 'PROJECT_USER_ASSIGNED',
                  projectId: project.id,
                  AND: [{ details: { path: ['__meta', 'targetUserId'], equals: uid } }],
                },
              })
            )
          )
        }
      } catch (err) {
        console.error('[PROJECT UPDATE] Error clearing notifications for status-blinded users:', err)
      }
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
          // Get all video IDs and video asset IDs for this project
          const [videoIds, videoAssetIds] = await Promise.all([
            prisma.video.findMany({
              where: { projectId: project.id },
              select: { id: true },
            }).then(rows => rows.map(r => r.id)),
            prisma.videoAsset.findMany({
              where: { video: { projectId: project.id } },
              select: { id: true },
            }).then(rows => rows.map(r => r.id)),
          ])

          // Collect StoredFile records to delete. We only shed the heavy playable
          // renditions (video 480/720/1080 + asset playback MP4) and keep everything
          // needed to still browse the FILES area after close: video THUMBNAIL,
          // timeline sprites/VTT, and the video-asset still image (PREVIEW_IMAGE).
          const videoPreviewRoles: FileRole[] = ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080']
          const assetPreviewRoles: FileRole[] = ['PREVIEW_MP4']
          // HLS bundles are heavy playable renditions too — shed them on close (the hls/ dir
          // per video + per asset). Reopen re-enqueues preview generation, which repackages HLS.
          const hlsDirRole: FileRole = 'HLS_SEGMENTS'

          // Get paths to delete from storage
          const [videoStored, assetStored, videoHlsDirs, assetHlsDirs] = await Promise.all([
            videoIds.length > 0 ? getStoredFileRecords('VIDEO', videoIds, { fileRoles: videoPreviewRoles, select: { storagePath: true } }) : [],
            videoAssetIds.length > 0 ? getStoredFileRecords('VIDEO_ASSET', videoAssetIds, { fileRoles: assetPreviewRoles, select: { storagePath: true } }) : [],
            videoIds.length > 0 ? getStoredFileRecords('VIDEO', videoIds, { fileRoles: [hlsDirRole], select: { storagePath: true } }) : [],
            videoAssetIds.length > 0 ? getStoredFileRecords('VIDEO_ASSET', videoAssetIds, { fileRoles: [hlsDirRole], select: { storagePath: true } }) : [],
          ])
          const allStoredFiles = [...videoStored, ...assetStored]

          // Delete files from storage (HLS bundles are whole directories).
          await Promise.allSettled(
            allStoredFiles.map(f => deleteFile(f.storagePath).catch(() => {}))
          )
          await Promise.allSettled(
            [...videoHlsDirs, ...assetHlsDirs].map(f => deleteDirectory(f.storagePath).catch(() => {}))
          )

          // Delete StoredFile records (no updatedAt bump on Video — raw deletion)
          if (videoIds.length > 0) {
            await deleteStoredFilesByCriteria({
              entityType: 'VIDEO',
              entityIds: videoIds,
              fileRoles: [...videoPreviewRoles, 'HLS_PLAYLIST', 'HLS_SEGMENTS'],
            })
          }
          if (videoAssetIds.length > 0) {
            await deleteStoredFilesByCriteria({
              entityType: 'VIDEO_ASSET',
              entityIds: videoAssetIds,
              fileRoles: [...assetPreviewRoles, 'HLS_PLAYLIST', 'HLS_SEGMENTS'],
            })
          }

          // Refresh precomputed storage totals so the dashboard reflects the freed
          // space immediately instead of waiting for the daily reconcile job.
          await Promise.allSettled([
            recalculateAndStoreProjectTotalBytes(project.id),
            recalculateAndStoreProjectPreviewBytes(project.id),
            recalculateAndStoreProjectDiskBytes(project.id),
          ])
        }
      } catch (err) {
        console.error('[PROJECT UPDATE] Error auto-deleting previews/zips on close:', err)
      }
    }

    // Re-generate previews, timeline sprites, and album ZIPs when project is reopened from CLOSED
    if (previousStatus === 'CLOSED' && validatedBody.status !== undefined && validatedBody.status !== 'CLOSED') {
      try {
        const requiredPreviewResolutions = new Set<PreviewResolution>(
          parsePreviewResolutions(currentProject.previewResolutions)
        )

        // Check READY videos for missing configured previews and/or timeline assets.
        const videosToEvaluate = await prisma.video.findMany({
          where: {
            projectId: project.id,
            status: 'READY',
          },
          select: {
            id: true,
            hlsReady: true,
          },
        })

        let queuedVideoPreviewJobs = 0
        if (videosToEvaluate.length > 0) {
          const videoQueue = getVideoQueue()
          const videoIds = videosToEvaluate.map(v => v.id)

          // Batch-load StoredFile records for all videos
          const videoStoredFiles = await getStoredFileRecords('VIDEO', videoIds, {
            select: { entityId: true, fileRole: true, storagePath: true },
          })

          const pathsByVideo = new Map<string, Map<string, string>>()
          for (const sf of videoStoredFiles) {
            let map = pathsByVideo.get(sf.entityId)
            if (!map) { map = new Map(); pathsByVideo.set(sf.entityId, map) }
            map.set(sf.fileRole, sf.storagePath)
          }

          for (const video of videosToEvaluate) {
            const stored = pathsByVideo.get(video.id) ?? new Map()
            const missingPreviewResolutions: PreviewResolution[] = []
            if (requiredPreviewResolutions.has('480p') && !stored.has('PREVIEW_480')) missingPreviewResolutions.push('480p')
            if (requiredPreviewResolutions.has('720p') && !stored.has('PREVIEW_720')) missingPreviewResolutions.push('720p')
            if (requiredPreviewResolutions.has('1080p') && !stored.has('PREVIEW_1080')) missingPreviewResolutions.push('1080p')

            const regenerateThumbnail = !stored.has('THUMBNAIL')
            const regenerateTimelinePreviews = Boolean(
              !stored.has('TIMELINE_VTT') ||
              !stored.has('TIMELINE_SPRITES')
            )

            if (
              missingPreviewResolutions.length === 0 &&
              !regenerateThumbnail &&
              !regenerateTimelinePreviews
            ) {
              // Thumbnail + timeline are intact (auto-close keeps them), but the HLS
              // bundle may have been shed on close — rebuild it directly from the original
              // so playback is restored immediately rather than waiting for the reconcile
              // sweep. Same deterministic jobId as the sweep, so the two dedupe.
              if (video.hlsReady === false) {
                await videoQueue.add(
                  'process-video',
                  { videoId: video.id, projectId: project.id, storagePath: '', hlsOnly: true },
                  { jobId: `hls-reconcile-${video.id}` },
                ).catch(() => {})
                queuedVideoPreviewJobs += 1
              }
              continue
            }

            const originalPath = stored.get('ORIGINAL')
            if (!originalPath) continue

            await prisma.video.update({
              where: { id: video.id },
              data: { status: 'QUEUED', processingProgress: 0, processingPhase: null },
            })
            if (missingPreviewResolutions.length > 0) {
              await videoQueue.add('process-video', {
                videoId: video.id,
                storagePath: originalPath,
                projectId: project.id,
                requestedPreviewResolutions: missingPreviewResolutions,
                regenerateThumbnail,
                regenerateTimelinePreviews,
              })
            } else if (regenerateThumbnail && !regenerateTimelinePreviews) {
              await videoQueue.add('process-video', {
                videoId: video.id,
                storagePath: originalPath,
                projectId: project.id,
                thumbnailOnly: true,
              })
            } else if (!regenerateThumbnail && regenerateTimelinePreviews) {
              await videoQueue.add('process-video', {
                videoId: video.id,
                storagePath: originalPath,
                projectId: project.id,
                timelineOnly: true,
              })
            } else {
              await videoQueue.add('process-video', {
                videoId: video.id,
                storagePath: originalPath,
                projectId: project.id,
                regenerateThumbnail: true,
                regenerateTimelinePreviews: true,
              })
            }
            queuedVideoPreviewJobs += 1
          }

          if (queuedVideoPreviewJobs > 0) {
            console.log(`[PROJECT UPDATE] Re-queued ${queuedVideoPreviewJobs} video job(s) for preview/timeline regeneration after reopen`)
          }
        }

        // Requeue share-upload previews that are missing, failed, or stale.
        const shareUploadFilesNeedingPreviews = await prisma.shareUploadFile.findMany({
          where: {
            projectId: project.id,
          },
          select: {
            id: true,
            fileType: true,
            fileName: true,
            mediaDurationSeconds: true,
            previewStatus: true,
          },
        })

        let queuedShareUploadPreviewJobs = 0
        if (shareUploadFilesNeedingPreviews.length > 0) {
          const suIds = shareUploadFilesNeedingPreviews.map(f => f.id)
          const suStored = await getStoredFileRecords('SHARE_UPLOAD_FILE', suIds, { fileRoles: ['PREVIEW_IMAGE', 'PREVIEW_MP4'], select: { entityId: true, fileRole: true } })
          const suHasPreview = new Set(suStored.map(s => s.entityId))

          for (const file of shareUploadFilesNeedingPreviews) {
            if (!isPreviewableMediaFileType(file.fileType)) continue
            const needsPreview = !suHasPreview.has(file.id) || file.previewStatus !== 'READY'
            if (!needsPreview) continue
            await prisma.shareUploadFile.update({
              where: { id: file.id },
              data: { previewAttempts: 0 },
            }).catch(() => {})
            await enqueueShareUploadPreview({
              type: 'shareUploadFile',
              recordId: file.id,
              storagePath: '', // Will be resolved from StoredFile by the worker
              fileType: file.fileType,
              fileName: file.fileName,
              durationSeconds: file.mediaDurationSeconds,
            }, { forceRequeue: true }).catch(() => {})
            queuedShareUploadPreviewJobs += 1
          }
        }

        // Requeue video-asset previews that are missing, failed, or stale.
        const videoAssetsNeedingPreviews = await prisma.videoAsset.findMany({
          where: {
            video: { projectId: project.id },
          },
          select: {
            id: true,
            fileType: true,
            fileName: true,
            previewStatus: true,
            hlsReady: true,
          },
        })

        let queuedVideoAssetPreviewJobs = 0
        if (videoAssetsNeedingPreviews.length > 0) {
          const vaIds = videoAssetsNeedingPreviews.map(a => a.id)
          const vaStored = await getStoredFileRecords('VIDEO_ASSET', vaIds, { fileRoles: ['PREVIEW_IMAGE', 'PREVIEW_MP4'], select: { entityId: true, fileRole: true } })
          const vaPreviewMap = new Map<string, Set<string>>()
          for (const s of vaStored) {
            let set = vaPreviewMap.get(s.entityId)
            if (!set) { set = new Set(); vaPreviewMap.set(s.entityId, set) }
            set.add(s.fileRole)
          }

          for (const asset of videoAssetsNeedingPreviews) {
            const normalizedType = String(asset.fileType || '').toLowerCase()
            if (!isPreviewableMediaFileType(normalizedType)) continue

            const previewRoles = vaPreviewMap.get(asset.id)
            // Video assets play via HLS (no MP4 preview since direct-to-HLS), so their
            // readiness is hlsReady — not the absent PREVIEW_MP4. Non-video assets still
            // gate on the still-image / playback preview being present.
            const hasPlaybackPreview = normalizedType.startsWith('video/')
              ? asset.hlsReady === true
              : (previewRoles?.has('PREVIEW_IMAGE') || previewRoles?.has('PREVIEW_MP4'))
            const needsPreview = !hasPlaybackPreview || asset.previewStatus !== 'READY'
            if (!needsPreview) continue

            await prisma.videoAsset.update({
              where: { id: asset.id },
              data: { previewAttempts: 0 },
            }).catch(() => {})
            await enqueueShareUploadPreview({
              type: 'videoAsset',
              recordId: asset.id,
              storagePath: '', // Will be resolved from StoredFile by the worker
              fileType: asset.fileType,
              fileName: asset.fileName,
            }, { forceRequeue: true }).catch(() => {})
            queuedVideoAssetPreviewJobs += 1
          }
        }

        if (queuedShareUploadPreviewJobs > 0 || queuedVideoAssetPreviewJobs > 0) {
          console.log(
            `[PROJECT UPDATE] Re-queued ${queuedShareUploadPreviewJobs} share-upload and ${queuedVideoAssetPreviewJobs} video-asset preview job(s) after reopen`
          )
        }
      } catch (err) {
        console.error('[PROJECT UPDATE] Error re-queuing previews after reopen:', err)
      }

      // Re-generate album ZIPs if they were auto-deleted
      try {
        // Re-queue album ZIPs that have no StoredFile ZIP record
        const albums = await prisma.album.findMany({
          where: {
            projectId: project.id,
            photos: { some: {} },
          },
          select: { id: true, socialCopiesEnabled: true },
        })
        if (albums.length > 0) {
          // Check which albums already have ZIP StoredFile records
          const albumIds = albums.map(a => a.id)
          const existingZips = await getStoredFileRecords('ALBUM', albumIds, { fileRoles: ['ZIP_FULL', 'ZIP_SOCIAL'], select: { entityId: true } })
          const hasZip = new Set(existingZips.map(z => z.entityId))
          const albumsToRequeue = albums.filter(a => !hasZip.has(a.id))

          if (albumsToRequeue.length > 0) {
            const q = getAlbumPhotoZipQueue()
            for (const album of albumsToRequeue) {
              const variants: AlbumZipVariant[] = album.socialCopiesEnabled ? ['full', 'social'] : ['full']
              for (const variant of variants) {
                const jobId = getAlbumZipJobId({ albumId: album.id, variant })
                await q.remove(jobId).catch(() => {})
                await q.add('generate-album-zip', { albumId: album.id, variant }, { jobId })
              }
            }
            console.log(`[PROJECT UPDATE] Re-queued ${albumsToRequeue.length} album(s) for ZIP regeneration after reopen`)
          }
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

          const settings = await prisma.settings.findUnique({
            where: { id: 'default' },
            select: {
              autoCloseApprovedProjectsEnabled: true,
              autoCloseApprovedProjectsAfterDays: true,
              clientEmailProjectApproved: true,
            },
          })

          if (recipients.length === 0) {
            console.log('[PROJECT UPDATE] No recipients opted in; skipping Project Approved email')
          } else if (settings?.clientEmailProjectApproved === false) {
            console.log('[PROJECT UPDATE] Skipped - clientEmailProjectApproved is disabled')
          } else {
            const shareUrl = await generateShareUrl(project.slug)
            const approvedVideos = await prisma.video.findMany({
              where: { projectId: project.id, approved: true },
              select: { id: true, name: true },
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

    // SECURITY: After password or authMode is updated in DB, invalidate ALL sessions for this project
    // This prevents clients from using old authentication/authorization even though security rules changed
    if (passwordWasChanged || authModeWasChanged) {
      try {
        // Invalidate JWT-based share sessions
        const shareSessionsInvalidated = await invalidateShareTokensByProject(id)

        // Also invalidate any legacy Redis sessions
        const legacySessionsInvalidated = await invalidateProjectSessions(id)

        // Log the security action
        const changes: string[] = []
        if (passwordWasChanged) changes.push('password')
        if (authModeWasChanged) changes.push('auth mode')
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
      previewBytes: (project as any).previewBytes == null ? null : asNumberBigInt((project as any).previewBytes),
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

    // Remove every StoredFile row for this project in one shot — all entity types,
    // not just videos/assets. Relies on the denormalized projectId; the previous
    // per-entity enumeration only cleaned VIDEO/VIDEO_ASSET and leaked album, photo,
    // comment, project-file, share-upload and email rows. The physical files are
    // removed by the whole-directory delete below.
    await deleteStoredFilesForProject(project.id)

    // Delete the entire project directory after all files are removed
    try {
      await deleteDirectory(
        project.storagePath || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)
      )
    } catch (error) {
      console.error(`Failed to delete project directory for ${id}:`, error)
      // Continue even if directory deletion fails
    }

    // Previews are ID-keyed and live outside the name-based project tree, so the
    // directory delete above does not cover them — remove previews/{projectId}/ too.
    try {
      await deleteDirectory(buildPreviewsRoot(project.id))
    } catch (error) {
      console.error(`Failed to delete preview directory for ${id}:`, error)
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
