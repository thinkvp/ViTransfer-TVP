import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getTransferTuningSettings } from '@/lib/settings'
import { deleteFile, getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
import { isS3Mode, s3GetPresignedDownloadUrl } from '@/lib/s3-storage'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { getStoredFilePathForProject } from '@/lib/stored-file'
import fs from 'fs'
import { createReadStream } from 'fs'

export const runtime = 'nodejs'

function isValidMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(trimmed)
}

async function assertProjectAccessOr404(projectId: string, auth: any) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } })
  if (!project) return null

  if (!isVisibleProjectStatusForUser(auth, project.status)) return null

  if (auth.appRoleIsSystemAdmin !== true) {
    const assignment = await prisma.projectUser.findUnique({
      where: {
        projectId_userId: {
          projectId: project.id,
          userId: auth.id,
        },
      },
      select: { projectId: true },
    })
    if (!assignment) return null
  }

  return project
}

// GET /api/projects/[id]/files/[fileId] - download project file (internal only)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id: projectId, fileId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many download requests. Please slow down.' },
    'project-file-download'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const file = await prisma.projectFile.findFirst({
    where: {
      id: fileId,
      projectId,
    },
    select: {
      id: true,
      fileName: true,
      fileType: true,
    },
  })

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  // Resolve storage path from StoredFile registry
  const storagePath = await getStoredFilePathForProject('PROJECT_FILE', file.id, 'ORIGINAL', projectId)
  if (!storagePath) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const sanitizedFilename = sanitizeFilenameForHeader(file.fileName)
  const contentType = isValidMimeType(file.fileType) ? file.fileType : 'application/octet-stream'

  // S3 mode: redirect to a presigned download URL
  if (isS3Mode()) {
    const presignedUrl = await s3GetPresignedDownloadUrl(storagePath, 300, file.fileName, contentType)
    return NextResponse.redirect(presignedUrl, {
      status: 302,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const fullPath = getFilePath(storagePath)
  const stat = await fs.promises.stat(fullPath)
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const { downloadChunkSizeBytes } = await getTransferTuningSettings()
  const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })
  let closed = false
  const readableStream = new ReadableStream({
    start(controller) {
      fileStream.on('data', (chunk) => {
        if (!closed) controller.enqueue(chunk)
      })
      fileStream.on('end', () => {
        if (!closed) { closed = true; controller.close() }
      })
      fileStream.on('error', (err) => {
        if (!closed) { closed = true; controller.error(err) }
      })
    },
    cancel() {
      closed = true
      fileStream.destroy()
    },
  })

  return new NextResponse(readableStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${sanitizedFilename}"`,
      'Content-Length': stat.size.toString(),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
    },
  })
}

// DELETE /api/projects/[id]/files/[fileId] - delete project file (internal only)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id: projectId, fileId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'uploadFilesToProjectInternal')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'project-file-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const file = await prisma.projectFile.findFirst({
    where: {
      id: fileId,
      projectId,
    },
    select: {
      id: true,
    },
  })

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  // Resolve storage path from StoredFile before deleting
  const storagePath = await getStoredFilePathForProject('PROJECT_FILE', file.id, 'ORIGINAL', projectId)

  // Delete the entity and its registry rows atomically so a crash/failure between the
  // two can't leave a dangling StoredFile row pointing at a deleted project file.
  await prisma.$transaction([
    prisma.projectFile.delete({ where: { id: fileId } }),
    prisma.storedFile.deleteMany({ where: { entityType: 'PROJECT_FILE', entityId: fileId } }),
  ])

  if (storagePath) {
    try {
      await deleteFile(storagePath)
    } catch {
      // Ignore storage delete errors; DB is source of truth.
    }
  }

  await recalculateAndStoreProjectTotalBytes(projectId)

  return NextResponse.json({ ok: true })
}
