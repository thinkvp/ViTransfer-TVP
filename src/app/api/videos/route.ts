import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { validateUploadedFile } from '@/lib/file-validation'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { isDropboxStorageConfigured, toDropboxStoragePath } from '@/lib/storage-provider-dropbox'
import { allocateUniqueStorageName, buildProjectStorageRoot, buildVideoOriginalDropboxPath, buildVideoOriginalStoragePath, getStoragePathBasename } from '@/lib/project-storage-paths'
export const runtime = 'nodejs'




// Prevent static generation for this route
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  // SECURITY: Require admin authentication
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }
  const admin = authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'uploadVideosOnProjects')
  if (forbiddenAction) return forbiddenAction

  // Rate limiting: Max 50 video uploads per hour
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 50,
    message: 'Too many video uploads. Please try again later.'
  }, 'upload-video')
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()
    const { projectId, versionLabel, originalFileName, originalFileSize, name, mimeType, videoNotes, allowApproval, dropboxEnabled } = body

    // Validate required fields
    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Video name is required' }, { status: 400 })
    }

    const videoName = name.trim()

    const trimmedVideoNotes = typeof videoNotes === 'string' ? videoNotes.trim() : ''
    if (trimmedVideoNotes.length > 500) {
      return NextResponse.json(
        { error: 'Version notes must be 500 characters or fewer' },
        { status: 400 }
      )
    }

    if (allowApproval !== undefined && typeof allowApproval !== 'boolean') {
      return NextResponse.json({ error: 'allowApproval must be a boolean' }, { status: 400 })
    }

    // Validate uploaded file
    const fileValidation = validateUploadedFile(
      originalFileName || 'upload.mp4',
      mimeType || 'video/mp4',
      originalFileSize || 0
    )

    if (!fileValidation.valid) {
      return NextResponse.json(
        { error: fileValidation.error || 'Invalid file' },
        { status: 400 }
      )
    }

    const sanitizedOriginalFileName = fileValidation.sanitizedFilename || 'upload.mp4'

    // Get the project and existing videos with the same name
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        client: { select: { name: true } },
        assignedUsers: { select: { userId: true } },
        videos: {
          where: { name: videoName },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Non-system-admins can only upload to projects explicitly assigned to them.
    if (admin.appRoleIsSystemAdmin !== true) {
      const assigned = project.assignedUsers?.some((u: any) => u.userId === admin.id)
      if (!assigned) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Enforce project status visibility
    if (!isVisibleProjectStatusForUser(admin, project.status)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Calculate next version number for this specific video name
    const nextVersion = project.videos.length > 0 ? project.videos[0].version + 1 : 1

    // Check if revisions are enabled and validate (per-video tracking)
    if (project.enableRevisions && project.maxRevisions > 0) {
      const existingVersionCount = await prisma.video.count({ where: { projectId, name: videoName } })
      if (existingVersionCount >= project.maxRevisions) {
        return NextResponse.json(
          { error: `Maximum revisions (${project.maxRevisions}) exceeded for this video` },
          { status: 400 }
        )
      }
    }

    const dropboxConfigured = isDropboxStorageConfigured()
    // dropboxEnabled is an explicit per-video toggle; only allowed when Dropbox is configured
    const effectiveDropboxEnabled = Boolean(dropboxEnabled) && dropboxConfigured
    const existingVersionFolder = await prisma.video.findFirst({
      where: { projectId, name: videoName },
      select: { storageFolderName: true, name: true },
      orderBy: { version: 'asc' },
    })
    const siblingVideoFolderRows = existingVersionFolder
      ? []
      : await prisma.video.findMany({
          where: { projectId },
          select: { storageFolderName: true, name: true },
        })
    const videoFolderName = existingVersionFolder
      ? (existingVersionFolder.storageFolderName || existingVersionFolder.name)
      : allocateUniqueStorageName(
          videoName,
          siblingVideoFolderRows
            .map((row) => row.storageFolderName || row.name)
            .filter(Boolean) as string[],
        )
    const effectiveVersionLabel = versionLabel || `v${nextVersion}`
    const projectStoragePath = project.storagePath
      || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)
    const localRelPath = buildVideoOriginalStoragePath(projectStoragePath, videoFolderName, effectiveVersionLabel, sanitizedOriginalFileName)
    const originalStoragePath = effectiveDropboxEnabled
      ? toDropboxStoragePath(localRelPath)
      : localRelPath

    const dropboxPath = effectiveDropboxEnabled
      ? buildVideoOriginalDropboxPath(
          project.client?.name || project.companyName || 'Client',
          getStoragePathBasename(projectStoragePath) || project.title,
          videoFolderName,
          effectiveVersionLabel,
          sanitizedOriginalFileName,
        )
      : null

    console.log(`[VIDEO] Storage path decision: dropboxEnabled=${effectiveDropboxEnabled}, dropboxConfigured=${dropboxConfigured}, backend=${effectiveDropboxEnabled ? 'dropbox' : 'local'}`)

    // Create video record
    const video = await prisma.video.create({
      data: {
        projectId,
        name: videoName,
        storageFolderName: videoFolderName,
        version: nextVersion,
        versionLabel: effectiveVersionLabel,
        videoNotes: trimmedVideoNotes ? trimmedVideoNotes : null,
        allowApproval: allowApproval ?? true,
        dropboxEnabled: effectiveDropboxEnabled,
        dropboxPath,
        originalFileName: sanitizedOriginalFileName,
        originalFileSize: BigInt(originalFileSize),
        originalStoragePath,
        status: 'UPLOADING',
        duration: 0,
        width: 0,
        height: 0,
      },
    })

    await recalculateAndStoreProjectTotalBytes(projectId)

    // Return videoId - TUS will handle upload directly
    const response = NextResponse.json({
      videoId: video.id,
      storageBackend: effectiveDropboxEnabled ? 'dropbox' : 'local',
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error creating video:', error)
    return NextResponse.json({ error: 'Failed to create video' }, { status: 500 })
  }
}
