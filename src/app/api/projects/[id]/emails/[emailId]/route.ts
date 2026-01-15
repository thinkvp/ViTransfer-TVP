import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteFile } from '@/lib/storage'
import { sanitizeEmailHtml } from '@/lib/security/email-html-sanitization'

export const runtime = 'nodejs'

const MAX_EMAIL_HTML_FOR_CID_REWRITE_CHARS = 250_000

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rewriteCidReferences(html: string, projectId: string, emailId: string, attachments: Array<{ id: string; contentId: string | null; isInline: boolean }>) {
  if (!html || !html.toLowerCase().includes('cid:')) return html

  let rewritten = html

  for (const att of attachments) {
    if (!att.isInline) continue
    if (!att.contentId) continue

    const url = `/api/projects/${projectId}/emails/${emailId}/attachments/${att.id}?inline=1`
    const pattern = new RegExp(`cid:(?:<)?${escapeRegExp(att.contentId)}(?:>)?`, 'gi')
    rewritten = rewritten.replace(pattern, url)
  }

  return rewritten
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

// GET /api/projects/[id]/emails/[emailId] - email detail for modal (internal only)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; emailId: string }> }
) {
  const { id: projectId, emailId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'accessProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-email-detail'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const email = await prisma.projectEmail.findFirst({
    where: { id: emailId, projectId },
    select: {
      id: true,
      subject: true,
      fromName: true,
      fromEmail: true,
      sentAt: true,
      textBody: true,
      htmlBody: true,
      hasAttachments: true,
      attachmentsCount: true,
      status: true,
      errorMessage: true,
      createdAt: true,
      attachments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          fileType: true,
          isInline: true,
          contentId: true,
          createdAt: true,
        },
      },
    },
  })

  if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 })

  const sanitizedHtml = (() => {
    if (!email.htmlBody) return null

    // CID rewriting does repeated regex passes and can be expensive on huge HTML bodies.
    // For very large content, skip CID rewriting and rely on the text body fallback.
    const candidate =
      email.htmlBody.length <= MAX_EMAIL_HTML_FOR_CID_REWRITE_CHARS
        ? rewriteCidReferences(email.htmlBody, projectId, email.id, email.attachments)
        : email.htmlBody

    const cleaned = sanitizeEmailHtml(candidate)
    return cleaned.length ? cleaned : ''
  })()

  return NextResponse.json({
    email: {
      id: email.id,
      subject: email.subject,
      fromName: email.fromName,
      fromEmail: email.fromEmail,
      sentAt: email.sentAt,
      textBody: email.textBody,
      htmlBody: sanitizedHtml,
      hasAttachments: email.hasAttachments,
      attachmentsCount: email.attachmentsCount,
      status: email.status,
      errorMessage: email.errorMessage,
      createdAt: email.createdAt,
      attachments: email.attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        fileSize: a.fileSize.toString(),
        fileType: a.fileType,
        isInline: a.isInline,
        contentId: a.contentId,
        createdAt: a.createdAt,
        downloadUrl: `/api/projects/${projectId}/emails/${email.id}/attachments/${a.id}`,
      })),
    },
  })
}

// DELETE /api/projects/[id]/emails/[emailId] - delete email + attachments (internal only)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; emailId: string }> }
) {
  const { id: projectId, emailId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'uploadFilesToProjectInternal')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'project-email-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const email = await prisma.projectEmail.findFirst({
    where: { id: emailId, projectId },
    select: {
      id: true,
      rawStoragePath: true,
      attachments: { select: { id: true, storagePath: true } },
    },
  })

  if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 })

  // Delete DB first; storage is best-effort.
  await prisma.projectEmail.delete({ where: { id: email.id } })

  // Best-effort storage cleanup
  try {
    await deleteFile(email.rawStoragePath)
  } catch {
    // ignore
  }

  for (const att of email.attachments) {
    try {
      await deleteFile(att.storagePath)
    } catch {
      // ignore
    }
  }

  return NextResponse.json({ ok: true })
}
