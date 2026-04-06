import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile, getFilePath, sanitizeFilenameForHeader, uploadFile } from '@/lib/storage'
import { getImageDimensions } from '@/lib/image-dimensions'
import { processImageBuffer } from '@/lib/image-processing'
import fs from 'fs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf']

// GET /api/admin/accounting/transactions/[id]/attachment — download attachment
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' },
    'admin-accounting-txn-attachment-download',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    select: { id: true, attachmentPath: true, attachmentOriginalName: true },
  })
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (!txn.attachmentPath) return NextResponse.json({ error: 'No attachment' }, { status: 404 })

  let fullPath: string
  try {
    fullPath = getFilePath(txn.attachmentPath)
  } catch {
    return NextResponse.json({ error: 'Invalid attachment path' }, { status: 500 })
  }

  const stat = await fs.promises.stat(fullPath).catch(() => null)
  if (!stat?.isFile()) return NextResponse.json({ error: 'Attachment file not found' }, { status: 404 })

  const ext = txn.attachmentPath.split('.').pop()?.toLowerCase() ?? ''
  const contentType = ext === 'pdf' ? 'application/pdf'
    : ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : 'image/jpeg'

  const filename = sanitizeFilenameForHeader(txn.attachmentOriginalName ?? `attachment.${ext}`)
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

// POST /api/admin/accounting/transactions/[id]/attachment — upload or replace attachment
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 20, message: 'Too many upload requests. Please slow down.' },
    'admin-accounting-txn-attachment-upload',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({ where: { id }, select: { id: true, attachmentPath: true } })
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  if (file.size <= 0) return NextResponse.json({ error: 'Empty file provided' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `File too large. Max ${MAX_BYTES / 1024 / 1024}MB.` }, { status: 413 })

  const mimeType = file.type || 'application/octet-stream'
  if (!ALLOWED_TYPES.includes(mimeType)) {
    return NextResponse.json({ error: 'Invalid file type. Accepted: JPEG, PNG, WebP, PDF.' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const isPdf = mimeType === 'application/pdf'

  if (!isPdf) {
    const dims = getImageDimensions(buffer)
    if (!dims) return NextResponse.json({ error: 'Invalid image file.' }, { status: 400 })
  }

  let finalBuffer = buffer
  let finalMime = mimeType
  let finalExt = isPdf ? 'pdf' : (mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg')

  if (!isPdf) {
    const processed = await processImageBuffer(buffer, mimeType)
    finalBuffer = Buffer.from(processed.buffer)
    finalMime = processed.mimeType
    finalExt = processed.ext
  }

  const storagePath = `accounting/transaction-attachments/${id}/attachment.${finalExt}`

  await uploadFile(storagePath, finalBuffer, finalBuffer.length, finalMime)

  // Remove old attachment if at a different path
  if (txn.attachmentPath && txn.attachmentPath !== storagePath) {
    await deleteFile(txn.attachmentPath).catch(() => {})
  }

  const originalName = file.name || `attachment.${finalExt}`
  await prisma.bankTransaction.update({
    where: { id },
    data: { attachmentPath: storagePath, attachmentOriginalName: originalName.slice(0, 500) },
  })

  return NextResponse.json({ attachmentPath: storagePath, attachmentOriginalName: originalName })
}

// DELETE /api/admin/accounting/transactions/[id]/attachment — remove attachment
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-txn-attachment-delete',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({ where: { id }, select: { id: true, attachmentPath: true } })
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (!txn.attachmentPath) return NextResponse.json({ error: 'No attachment to delete' }, { status: 404 })

  await deleteFile(txn.attachmentPath).catch(() => {})
  await prisma.bankTransaction.update({ where: { id }, data: { attachmentPath: null, attachmentOriginalName: null } })

  return NextResponse.json({ ok: true })
}
