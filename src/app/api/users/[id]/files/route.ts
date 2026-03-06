import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest, requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { validateAssetFile } from '@/lib/file-validation'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createUserFileSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .refine((val) => Number.isFinite(val) && Number.isInteger(val) && val > 0 && val <= Number.MAX_SAFE_INTEGER, {
      message: 'fileSize must be a positive integer',
    }),
  mimeType: z.string().max(255).optional(),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: userId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'users')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-user-files-list'
  )
  if (rateLimitResult) return rateLimitResult

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const files = await prisma.userFile.findMany({
    where: { userId },
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

  return NextResponse.json({
    files: files.map((file) => ({
      ...file,
      fileSize: file.fileSize.toString(),
    })),
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: userId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'users')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 50, message: 'Too many upload requests. Please slow down.' },
    'admin-user-file-create'
  )
  if (rateLimitResult) return rateLimitResult

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const currentUser = await getCurrentUserFromRequest(request)
  if (!currentUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const parsed = createUserFileSchema.safeParse(body)
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
  const storagePath = `users/${userId}/files/userfile-${timestamp}-${sanitizedFileName}`

  const category = fileValidation.detectedCategory || 'other'

  const record = await prisma.userFile.create({
    data: {
      userId,
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

  return NextResponse.json({ userFileId: record.id })
}
