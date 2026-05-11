/**
 * POST /api/projects/[id]/files/s3/presign
 *
 * Initiates a browser-direct multipart upload to S3/R2 for a project file,
 * returning presigned PUT URLs for each part.
 *
 * Only available when STORAGE_PROVIDER=s3.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3InitiateMultipartUpload, s3GetPresignedPartUrl } from '@/lib/s3-storage'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { validateAssetFile } from '@/lib/file-validation'
import { buildProjectFilesStoragePath, buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { getSafeguardLimits } from '@/lib/settings'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'

const MIN_PART_SIZE_BYTES = 16 * 1024 * 1024
const MAX_PART_SIZE_BYTES = 256 * 1024 * 1024
const MAX_PARTS = 10_000
const PART_URL_EXPIRES_SECONDS = 3600

function calculatePartSize(fileSize: number): number {
  let partSize = MIN_PART_SIZE_BYTES
  while (Math.ceil(fileSize / partSize) > MAX_PARTS && partSize < MAX_PART_SIZE_BYTES) {
    partSize = Math.min(partSize * 2, MAX_PART_SIZE_BYTES)
  }
  return partSize
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const limited = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many upload requests' },
    'project-files-s3-presign'
  )
  if (limited) return limited

  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  const forbiddenAction = requireActionAccess(authResult, 'uploadFilesToProjectInternal')
  if (forbiddenAction) return forbiddenAction

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      status: true,
      storagePath: true,
      title: true,
      companyName: true,
      client: { select: { name: true } },
    },
  })

  if (!project || !isVisibleProjectStatusForUser(authResult, project.status)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  if (authResult.appRoleIsSystemAdmin !== true) {
    const assignment = await prisma.projectUser.findUnique({
      where: { projectId_userId: { projectId, userId: authResult.id } },
      select: { projectId: true },
    })
    if (!assignment) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { fileName, fileSize, contentType } = body

  if (!fileName || typeof fileName !== 'string') {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 })
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 })
  }

  const fileValidation = validateAssetFile(fileName, contentType || 'application/octet-stream')
  if (!fileValidation.valid) {
    return NextResponse.json({ error: fileValidation.error || 'Invalid file' }, { status: 400 })
  }

  const { maxProjectFilesPerProject } = await getSafeguardLimits()
  const existingCount = await prisma.projectFile.count({ where: { projectId } })
  if (existingCount >= maxProjectFilesPerProject) {
    return NextResponse.json(
      { error: `Maximum project files (${maxProjectFilesPerProject}) reached for this project` },
      { status: 400 }
    )
  }

  const sanitizedFileName =
    fileValidation.sanitizedFilename || fileName.replace(/[^a-zA-Z0-9 ._-]/g, '_').substring(0, 255)
  const timestamp = Date.now()
  const projectStoragePath =
    project.storagePath ||
    buildProjectStorageRoot(
      project.client?.name || project.companyName || 'Client',
      project.title,
    )
  const s3Key = buildProjectFilesStoragePath(projectStoragePath, sanitizedFileName, timestamp)
  const category = fileValidation.detectedCategory || 'other'

  const partSize = calculatePartSize(fileSize)
  const partCount = Math.ceil(fileSize / partSize)

  let s3UploadId: string
  try {
    s3UploadId = await s3InitiateMultipartUpload(s3Key, contentType || 'application/octet-stream')
  } catch (err) {
    console.error('[PROJECT FILES S3 PRESIGN] Failed to initiate multipart upload:', err)
    return NextResponse.json({ error: 'Failed to initiate upload' }, { status: 500 })
  }

  const parts: Array<{ partNumber: number; url: string }> = []
  for (let i = 0; i < partCount; i++) {
    const url = await s3GetPresignedPartUrl(s3Key, s3UploadId, i + 1, PART_URL_EXPIRES_SECONDS)
    parts.push({ partNumber: i + 1, url })
  }

  return NextResponse.json({
    uploadId: s3UploadId,
    key: s3Key,
    parts,
    partSize,
    sanitizedFileName,
    category,
  })
}
