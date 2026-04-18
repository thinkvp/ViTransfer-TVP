import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getImageDimensions } from '@/lib/image-dimensions'
import { processImageBuffer } from '@/lib/image-processing'
import { buildBasPeriodFilePath, writeAccountingFile } from '@/lib/accounting/file-storage'
import { accountingAttachmentFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf']

// POST /api/admin/accounting/bas/[id]/attachments — upload one or more files
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many upload requests. Please slow down.' },
    'admin-accounting-bas-attachments-upload',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const period = await prisma.basPeriod.findUnique({
    where: { id },
    select: { id: true, startDate: true },
  })
  if (!period) return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })

  const formData = await request.formData()
  const files = formData.getAll('file') as File[]
  if (files.length === 0) return NextResponse.json({ error: 'No files provided' }, { status: 400 })

  const created = []
  for (const file of files) {
    if (!(file instanceof File)) continue
    if (file.size <= 0) continue
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: `File "${file.name}" too large. Max ${MAX_BYTES / 1024 / 1024}MB.` }, { status: 413 })
    }
    const mimeType = file.type || 'application/octet-stream'
    if (!ALLOWED_TYPES.includes(mimeType)) {
      return NextResponse.json({ error: `File "${file.name}": invalid type. Accepted: JPEG, PNG, WebP, PDF.` }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const isPdf = mimeType === 'application/pdf'

    if (!isPdf) {
      const dims = getImageDimensions(buffer)
      if (!dims) return NextResponse.json({ error: `File "${file.name}" is not a valid image.` }, { status: 400 })
    }

    let finalBuffer = buffer
    let finalExt = isPdf ? 'pdf' : (mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg')

    if (!isPdf) {
      const processed = await processImageBuffer(buffer, mimeType)
      finalBuffer = Buffer.from(processed.buffer)
      finalExt = processed.ext
    }

    const rawName = file.name || `attachment.${finalExt}`
    const nameWithoutExt = rawName.replace(/\.[^.]+$/, '')
    const originalName = `${nameWithoutExt}.${finalExt}`

    const storagePath = await buildBasPeriodFilePath(period.startDate, originalName)
    await writeAccountingFile(storagePath, finalBuffer)

    const attachment = await prisma.accountingAttachment.create({
      data: {
        storagePath: storagePath.relativePath,
        originalName: rawName.slice(0, 500),
        basPeriodId: id,
      },
    })
    created.push(accountingAttachmentFromDb(attachment))
  }

  return NextResponse.json({ attachments: created })
}
