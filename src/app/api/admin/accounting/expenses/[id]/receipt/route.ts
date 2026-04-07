import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { sanitizeFilenameForHeader } from '@/lib/storage'
import { getImageDimensions } from '@/lib/image-dimensions'
import { processImageBuffer } from '@/lib/image-processing'
import {
  buildAccountingFilePath,
  writeAccountingFile,
  readAccountingFile,
  deleteAccountingFile,
  resolveAccountingFilePath,
} from '@/lib/accounting/file-storage'
import fs from 'fs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf']

// GET /api/admin/accounting/expenses/[id]/receipt — download receipt
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' },
    'admin-accounting-receipt-download',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const expense = await prisma.expense.findUnique({
    where: { id },
    select: { id: true, receiptPath: true, receiptOriginalName: true },
  })
  if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  if (!expense.receiptPath) return NextResponse.json({ error: 'No receipt attached' }, { status: 404 })

  let fullPath: string
  try {
    fullPath = resolveAccountingFilePath(expense.receiptPath)
  } catch {
    return NextResponse.json({ error: 'Invalid receipt path' }, { status: 500 })
  }

  const stat = await fs.promises.stat(fullPath).catch(() => null)
  if (!stat?.isFile()) return NextResponse.json({ error: 'Receipt file not found' }, { status: 404 })

  const ext = expense.receiptPath.split('.').pop()?.toLowerCase() ?? ''
  const contentType = ext === 'pdf' ? 'application/pdf'
    : ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : 'image/jpeg'

  const filename = sanitizeFilenameForHeader(expense.receiptOriginalName ?? `receipt.${ext}`)
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

// POST /api/admin/accounting/expenses/[id]/receipt — upload or replace receipt image
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many upload requests. Please slow down.' },
    'admin-accounting-receipt-upload',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const expense = await prisma.expense.findUnique({
    where: { id },
    select: { id: true, date: true, accountId: true, receiptPath: true },
  })
  if (!expense) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (file.size <= 0) {
    return NextResponse.json({ error: 'Empty file provided' }, { status: 400 })
  }

  if (file.size > MAX_RECEIPT_BYTES) {
    return NextResponse.json(
      { error: `Receipt file is too large. Max size is ${MAX_RECEIPT_BYTES / 1024 / 1024}MB.` },
      { status: 413 }
    )
  }

  const mimeType = file.type || 'application/octet-stream'
  const isPdf = mimeType === 'application/pdf'

  if (!ALLOWED_TYPES.includes(mimeType)) {
    return NextResponse.json(
      { error: 'Invalid file type. Accepted: JPEG, PNG, WebP, PDF.' },
      { status: 400 }
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  if (!isPdf) {
    const dims = getImageDimensions(buffer)
    if (!dims) {
      return NextResponse.json(
        { error: 'Invalid image. Please upload a JPEG, PNG, or WebP image, or a PDF.' },
        { status: 400 }
      )
    }
  }

  let finalBuffer = buffer
  let finalExt = isPdf ? 'pdf' : (mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg')

  if (!isPdf) {
    const processed = await processImageBuffer(buffer, mimeType)
    finalBuffer = Buffer.from(processed.buffer)
    finalExt = processed.ext
  }

  // Build original filename — keep user's name but force correct extension
  const rawName = file.name || `receipt.${finalExt}`
  const nameWithoutExt = rawName.replace(/\.[^.]+$/, '')
  const originalName = `${nameWithoutExt}.${finalExt}`

  // Use the expense date + account to determine FY folder & account folder
  const storagePath = await buildAccountingFilePath(expense.date, expense.accountId, originalName)
  await writeAccountingFile(storagePath, finalBuffer)

  // Remove old receipt if it was at a different path
  if (expense.receiptPath && expense.receiptPath !== storagePath.relativePath) {
    await deleteAccountingFile(expense.receiptPath).catch(() => {})
  }

  await prisma.expense.update({
    where: { id },
    data: {
      receiptPath: storagePath.relativePath,
      receiptOriginalName: rawName.slice(0, 500),
    },
  })

  return NextResponse.json({ receiptPath: storagePath.relativePath })
}

// DELETE /api/admin/accounting/expenses/[id]/receipt — remove receipt
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-receipt-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const expense = await prisma.expense.findUnique({ where: { id }, select: { id: true, receiptPath: true } })
  if (!expense) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }

  if (!expense.receiptPath) {
    return NextResponse.json({ error: 'No receipt attached' }, { status: 404 })
  }

  await deleteAccountingFile(expense.receiptPath).catch(() => {})
  await prisma.expense.update({ where: { id }, data: { receiptPath: null, receiptOriginalName: null } })

  return NextResponse.json({ ok: true })
}
