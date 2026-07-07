import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import {
  normalizeProjectUploadRelativePath,
  sanitizeStorageName,
} from '@/lib/project-storage-paths'
import {
  resolveUploadFolderStoragePath,
  ensureUploadFolderExistsInStorage,
} from '@/lib/share-upload-folder-storage'
import {
  authorizeUploadFolders,
  resolveUploadFolderProjectStoragePath,
} from '@/lib/project-upload-folders-admin'
import { getStoredFileRecords } from '@/lib/stored-file'
import { asNumberBigInt } from '@/lib/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/projects/[id]/upload-folders - list upload folders + files (admin)
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const gate = await authorizeUploadFolders(request, projectId)
  if (gate.response) return gate.response

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-upload-folders-list',
  )
  if (rateLimitResult) return rateLimitResult

  const [folders, files] = await Promise.all([
    prisma.shareUploadFolder.findMany({
      where: { projectId },
      orderBy: [{ relativePath: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, relativePath: true, folderName: true, createdAt: true },
    }),
    prisma.shareUploadFile.findMany({
      where: { projectId },
      orderBy: [{ folderRelativePath: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        folderRelativePath: true,
        fileName: true,
        fileType: true,
        previewStatus: true,
        createdAt: true,
      },
    }),
  ])

  // Real original-file sizes come from StoredFile (ID-keyed ORIGINAL role).
  const fileIds = files.map((f) => f.id)
  const sizeById = new Map<string, bigint | null>()
  if (fileIds.length > 0) {
    const originals = (await getStoredFileRecords('SHARE_UPLOAD_FILE', fileIds, {
      fileRoles: ['ORIGINAL'],
      select: { entityId: true, fileSize: true },
    })) as Array<{ entityId: string; fileSize: bigint | null }>
    for (const rec of originals) sizeById.set(rec.entityId, rec.fileSize)
  }

  return NextResponse.json({
    folders,
    files: files.map((f) => ({ ...f, fileSize: asNumberBigInt(sizeById.get(f.id)) })),
  })
}

// POST /api/projects/[id]/upload-folders - create a top-level upload folder (admin)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const gate = await authorizeUploadFolders(request, projectId)
  if (gate.response) return gate.response
  const { auth, project } = gate

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'project-upload-folders-create',
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)
  const folderNameRaw = String(body?.folderName || '').trim()
  if (!folderNameRaw) {
    return NextResponse.json({ error: 'folderName is required' }, { status: 400 })
  }

  const safeFolderName = sanitizeStorageName(folderNameRaw)
  // Admin folders are always top-level (no parent path).
  const relativePath = normalizeProjectUploadRelativePath(safeFolderName)
  if (!relativePath) {
    return NextResponse.json({ error: 'Invalid folder name' }, { status: 400 })
  }

  const existing = await prisma.shareUploadFolder.findUnique({
    where: { projectId_relativePath: { projectId, relativePath } },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json({ error: 'A folder with that name already exists' }, { status: 409 })
  }

  const projectStoragePath = resolveUploadFolderProjectStoragePath(project)
  const storagePath = await resolveUploadFolderStoragePath({
    projectId,
    projectStoragePath,
    folderRelativePath: relativePath,
  })

  try {
    await ensureUploadFolderExistsInStorage(storagePath)
  } catch (error) {
    console.error('[PROJECT UPLOADS] Failed to create storage folder:', error)
    return NextResponse.json({ error: 'Failed to create folder in storage' }, { status: 500 })
  }

  const folder = await prisma.shareUploadFolder.create({
    data: {
      projectId,
      relativePath,
      folderName: safeFolderName,
      storagePath,
      createdById: auth.id,
      createdByName: auth.name || auth.email,
    },
    select: { id: true, relativePath: true, folderName: true, createdAt: true },
  })

  return NextResponse.json({ folder }, { status: 201 })
}
