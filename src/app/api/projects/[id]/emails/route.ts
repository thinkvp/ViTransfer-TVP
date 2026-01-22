import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest, requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getSafeguardLimits } from '@/lib/settings'
import { validateEmlFilename } from '@/lib/eml-validation'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const listSchema = z.object({
  page: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? 1 : Number(v)))
    .refine((v) => Number.isFinite(v) && v >= 1 && Number.isInteger(v), { message: 'page must be an integer >= 1' }),
  perPage: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? 10 : Number(v)))
    .refine((v) => Number.isFinite(v) && v >= 1 && v <= 50 && Number.isInteger(v), { message: 'perPage must be 1..50' }),
  sortKey: z
    .enum(['sentAt', 'subject', 'from', 'attachments'])
    .optional()
    .default('sentAt'),
  sortDir: z
    .enum(['asc', 'desc'])
    .optional()
    .default('desc'),
})

const createSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .refine((val) => Number.isFinite(val) && Number.isInteger(val) && val > 0 && val <= Number.MAX_SAFE_INTEGER, {
      message: 'fileSize must be a positive integer',
    }),
  mimeType: z.string().max(255).optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, { message: 'sha256 must be a 64-character hex string' })
    .optional(),
})

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

// GET /api/projects/[id]/emails - list imported emails (internal only)
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'accessProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-emails-list'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const url = new URL(request.url)
  const parsed = listSchema.safeParse({
    page: url.searchParams.get('page') ?? undefined,
    perPage: url.searchParams.get('perPage') ?? undefined,
    sortKey: url.searchParams.get('sortKey') ?? undefined,
    sortDir: url.searchParams.get('sortDir') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const { page, perPage, sortKey, sortDir } = parsed.data
  const skip = (page - 1) * perPage

  const dir = sortDir

  const orderBy = (() => {
    if (sortKey === 'subject') return [{ subject: dir as any }, { sentAt: 'desc' as const }, { createdAt: 'desc' as const }]
    if (sortKey === 'from') return [{ fromName: dir as any }, { sentAt: 'desc' as const }, { createdAt: 'desc' as const }]
    if (sortKey === 'attachments') return [{ attachmentsCount: dir as any }, { sentAt: 'desc' as const }, { createdAt: 'desc' as const }]
    return [{ sentAt: dir as any }, { createdAt: 'desc' as const }]
  })()

  const [totalCount, rows] = await Promise.all([
    prisma.projectEmail.count({ where: { projectId } }),
    prisma.projectEmail.findMany({
      where: { projectId },
      orderBy,
      skip,
      take: perPage,
      select: {
        id: true,
        subject: true,
        fromName: true,
        fromEmail: true,
        sentAt: true,
        attachmentsCount: true,
        hasAttachments: true,
        status: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  ])

  return NextResponse.json({
    page,
    perPage,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / perPage)),
    emails: rows,
  })
}

// POST /api/projects/[id]/emails - create email record for TUS upload (internal only)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'uploadFilesToProjectInternal')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 50, message: 'Too many upload requests. Please slow down.' },
    'project-email-create'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const currentUser = await getCurrentUserFromRequest(request)
  if (!currentUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const { fileName, fileSize, mimeType } = parsed.data

  const sha256 = parsed.data.sha256 ? parsed.data.sha256.toLowerCase() : null

  const nameValidation = validateEmlFilename(fileName)
  if (!nameValidation.valid) {
    return NextResponse.json({ error: nameValidation.error || 'Invalid email file' }, { status: 400 })
  }

  if (sha256) {
    const existing = await prisma.projectEmail.findFirst({
      where: { projectId, rawSha256: sha256 },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json({ error: 'Duplicate email already imported' }, { status: 409 })
    }
  }

  // Guardrail: reuse project file limit (same internal permission surface)
  const { maxProjectFilesPerProject } = await getSafeguardLimits()
  const existingCount = await prisma.projectEmail.count({ where: { projectId } })
  if (existingCount >= maxProjectFilesPerProject) {
    return NextResponse.json(
      { error: `Maximum communications (${maxProjectFilesPerProject}) reached for this project` },
      { status: 400 }
    )
  }

  const timestamp = Date.now()
  const sanitizedFileName = nameValidation.sanitizedFilename!
  const storagePath = `projects/${projectId}/communication/raw/email-${timestamp}-${sanitizedFileName}`

  const record = await prisma.projectEmail.create({
    data: {
      projectId,
      rawFileName: sanitizedFileName,
      rawFileSize: BigInt(fileSize),
      rawFileType: mimeType || 'application/octet-stream',
      rawStoragePath: storagePath,
      rawSha256: sha256,
      status: 'UPLOADING',
      uploadedBy: currentUser.id,
      uploadedByName: currentUser.name || currentUser.email,
    },
    select: { id: true },
  })

  await recalculateAndStoreProjectTotalBytes(projectId)

  return NextResponse.json({ projectEmailId: record.id })
}
