import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest, requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { validateAssetFile } from '@/lib/file-validation'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createClientFileSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .refine((val) => Number.isFinite(val) && Number.isInteger(val) && val > 0 && val <= Number.MAX_SAFE_INTEGER, {
      message: 'fileSize must be a positive integer',
    }),
  mimeType: z.string().max(255).optional(),
})

// GET /api/clients/[id]/files - list client files
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClientFiles')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-client-files-list'
  )
  if (rateLimitResult) return rateLimitResult

  const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true } })
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const files = await prisma.clientFile.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fileName: true,
      fileSize: true,
      fileType: true,
      category: true,
      createdAt: true,
      uploadedByName: true,
    },
  })

  const serialized = files.map((f) => ({
    ...f,
    fileSize: f.fileSize.toString(),
  }))

  return NextResponse.json({ files: serialized })
}

// POST /api/clients/[id]/files - create file record for TUS upload
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'clients')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageClientFiles')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 50, message: 'Too many upload requests. Please slow down.' },
    'admin-client-file-create'
  )
  if (rateLimitResult) return rateLimitResult

  const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true } })
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const currentUser = await getCurrentUserFromRequest(request)
  if (!currentUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const parsed = createClientFileSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const { fileName, fileSize, mimeType } = parsed.data

  const fileValidation = validateAssetFile(fileName, mimeType || 'application/octet-stream')
  if (!fileValidation.valid) {
    return NextResponse.json({ error: fileValidation.error || 'Invalid file' }, { status: 400 })
  }

  const timestamp = Date.now()
  const sanitizedFileName =
    fileValidation.sanitizedFilename || fileName.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 255)
  const storagePath = `clients/${clientId}/files/clientfile-${timestamp}-${sanitizedFileName}`

  const category = fileValidation.detectedCategory || 'other'

  const record = await prisma.clientFile.create({
    data: {
      clientId,
      fileName: sanitizedFileName,
      fileSize: BigInt(fileSize),
      fileType: 'application/octet-stream',
      storagePath,
      category,
      uploadedBy: currentUser.id,
      uploadedByName: currentUser.name || currentUser.email,
    },
    select: { id: true },
  })

  return NextResponse.json({ clientFileId: record.id })
}
