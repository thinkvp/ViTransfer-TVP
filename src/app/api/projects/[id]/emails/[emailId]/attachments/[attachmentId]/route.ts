import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getFilePath, sanitizeFilenameForHeader } from '@/lib/storage'
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

// GET /api/projects/[id]/emails/[emailId]/attachments/[attachmentId] - download attachment (internal only)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; emailId: string; attachmentId: string }> }
) {
  const { id: projectId, emailId, attachmentId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'accessProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many download requests. Please slow down.' },
    'project-email-attachment-download'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const attachment = await prisma.projectEmailAttachment.findFirst({
    where: {
      id: attachmentId,
      projectEmailId: emailId,
      projectEmail: { projectId },
    },
    select: {
      id: true,
      fileName: true,
      fileType: true,
      storagePath: true,
      isInline: true,
    },
  })

  if (!attachment) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })

  const fullPath = getFilePath(attachment.storagePath)
  const stat = await fs.promises.stat(fullPath)
  if (!stat.isFile()) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })

  const url = new URL(request.url)
  const inlineRequested = url.searchParams.get('inline') === '1'

  const sanitizedFilename = sanitizeFilenameForHeader(attachment.fileName)
  const contentType = isValidMimeType(attachment.fileType) ? attachment.fileType : 'application/octet-stream'

  const dispositionType = inlineRequested && attachment.isInline ? 'inline' : 'attachment'

  const fileStream = createReadStream(fullPath)
  const readableStream = new ReadableStream({
    start(controller) {
      fileStream.on('data', (chunk) => controller.enqueue(chunk))
      fileStream.on('end', () => controller.close())
      fileStream.on('error', (err) => controller.error(err))
    },
    cancel() {
      fileStream.destroy()
    },
  })

  return new NextResponse(readableStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `${dispositionType}; filename="${sanitizedFilename}"`,
      'Content-Length': stat.size.toString(),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
    },
  })
}
