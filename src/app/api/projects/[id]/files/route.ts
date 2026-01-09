import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest, requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { validateAssetFile } from '@/lib/file-validation'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createProjectFileSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .refine((val) => Number.isFinite(val) && Number.isInteger(val) && val > 0 && val <= Number.MAX_SAFE_INTEGER, {
      message: 'fileSize must be a positive integer',
    }),
  mimeType: z.string().max(255).optional(),
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

// GET /api/projects/[id]/files - list project files (internal only)
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
    'project-files-list'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const files = await prisma.projectFile.findMany({
    where: { projectId },
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

// POST /api/projects/[id]/files - create file record for TUS upload (internal only)
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
    'project-file-create'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const currentUser = await getCurrentUserFromRequest(request)
  if (!currentUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const parsed = createProjectFileSchema.safeParse(body)
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
  const storagePath = `projects/${projectId}/files/projectfile-${timestamp}-${sanitizedFileName}`

  const category = fileValidation.detectedCategory || 'other'

  const record = await prisma.projectFile.create({
    data: {
      projectId,
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

  return NextResponse.json({ projectFileId: record.id })
}
