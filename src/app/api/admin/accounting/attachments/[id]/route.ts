import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { sanitizeFilenameForHeader } from '@/lib/storage'
import { deleteAccountingFile, resolveAccountingFilePath } from '@/lib/accounting/file-storage'
import fs from 'fs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/accounting/attachments/[id] — download a single AccountingAttachment
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' },
    'admin-accounting-attachment-download',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const attachment = await prisma.accountingAttachment.findUnique({
    where: { id },
    select: { id: true, storagePath: true, originalName: true },
  })
  if (!attachment) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })

  let fullPath: string
  try {
    fullPath = resolveAccountingFilePath(attachment.storagePath)
  } catch {
    return NextResponse.json({ error: 'Invalid attachment path' }, { status: 500 })
  }

  const stat = await fs.promises.stat(fullPath).catch(() => null)
  if (!stat?.isFile()) return NextResponse.json({ error: 'Attachment file not found' }, { status: 404 })

  const ext = attachment.storagePath.split('.').pop()?.toLowerCase() ?? ''
  const contentType =
    ext === 'pdf' ? 'application/pdf'
    : ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : 'image/jpeg'

  const filename = sanitizeFilenameForHeader(attachment.originalName)
  const fileBuffer = await fs.promises.readFile(fullPath)

  return new NextResponse(fileBuffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': fileBuffer.length.toString(),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
    },
  })
}

// DELETE /api/admin/accounting/attachments/[id] — delete a single AccountingAttachment
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many requests.' },
    'admin-accounting-attachment-delete',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const attachment = await prisma.accountingAttachment.findUnique({
    where: { id },
    select: { id: true, storagePath: true },
  })
  if (!attachment) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })

  await deleteAccountingFile(attachment.storagePath).catch(() => {})
  await prisma.accountingAttachment.delete({ where: { id } })

  return NextResponse.json({ ok: true })
}
