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
  getUploadFolderParentRelativePath as getParentRelativePath,
  deleteUploadFile,
  deleteUploadFolderTree,
  renameUploadFolder,
} from '@/lib/share-upload-folder-storage'
import { resolveProjectStoragePath, resolveShareUploadAccess, resolveShareUploadActor } from '@/lib/share-uploads'
import { publishProjectEvent } from '@/lib/project-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface FolderListItem {
  id: string
  relativePath: string
  folderName: string
  createdAt: Date
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    `share-uploads-list:${token}`,
  )
  if (rateLimitResult) return rateLimitResult

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canRead) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [folders, files] = await Promise.all([
    prisma.shareUploadFolder.findMany({
      where: { projectId: access.project.id },
      orderBy: [{ relativePath: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        relativePath: true,
        folderName: true,
        createdAt: true,
      },
    }),
    prisma.shareUploadFile.findMany({
      where: { projectId: access.project.id },
      orderBy: [{ folderRelativePath: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        folderRelativePath: true,
        fileName: true,
        fileType: true,
        createdAt: true,
        previewStatus: true,
      },
    }),
  ])

  const folderItems = folders.map((folder: FolderListItem) => ({
    ...folder,
    parentRelativePath: getParentRelativePath(folder.relativePath),
  }))

  const fileItems = files.map((file) => ({
    ...file,
    fileSize: '0' as const, // From StoredFile if needed
  }))

  return NextResponse.json({
    canUpload: access.canUpload,
    canDelete: access.canDelete,
    folders: folderItems,
    files: fileItems,
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    `share-uploads-create-folder:${token}`,
  )
  if (rateLimitResult) return rateLimitResult

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canUpload) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const folderNameRaw = String(body?.folderName || '').trim()
  const parentPathRaw = String(body?.parentPath || '').trim()

  if (!folderNameRaw) {
    return NextResponse.json({ error: 'folderName is required' }, { status: 400 })
  }

  const safeFolderName = sanitizeStorageName(folderNameRaw)
  const normalizedParentPath = normalizeProjectUploadRelativePath(parentPathRaw)
  const relativePath = normalizeProjectUploadRelativePath(
    normalizedParentPath ? `${normalizedParentPath}/${safeFolderName}` : safeFolderName,
  )

  if (!relativePath) {
    return NextResponse.json({ error: 'Invalid folder path' }, { status: 400 })
  }

  const projectStoragePath = resolveProjectStoragePath(access.project)
  const storagePath = await resolveUploadFolderStoragePath({
    projectId: access.project.id,
    projectStoragePath,
    folderRelativePath: relativePath,
  })

  try {
    await ensureUploadFolderExistsInStorage(storagePath)
  } catch (error) {
    console.error('[SHARE UPLOADS] Failed to create storage folder:', error)
    return NextResponse.json({ error: 'Failed to create folder in storage' }, { status: 500 })
  }

  const actor = await resolveShareUploadActor(access, {
    recipientId: body?.recipientId,
    authorName: body?.authorName,
  })

  const folder = await prisma.shareUploadFolder.upsert({
    where: {
      projectId_relativePath: {
        projectId: access.project.id,
        relativePath,
      },
    },
    update: {
      folderName: safeFolderName,
    },
    create: {
      projectId: access.project.id,
      relativePath,
      folderName: safeFolderName,
      storagePath,
      createdById: actor.userId,
      createdByRecipientId: actor.recipientId,
      createdByName: actor.name,
    },
    select: {
      id: true,
      relativePath: true,
      folderName: true,
      storagePath: true,
      createdAt: true,
    },
  })

  // Notify open share pages / admin views so the new folder appears live.
  await publishProjectEvent(access.project.id, 'upload')

  return NextResponse.json({
    success: true,
    folder: {
      ...folder,
      parentRelativePath: getParentRelativePath(folder.relativePath),
    },
  })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    `share-uploads-delete:${token}`,
  )
  if (rateLimitResult) return rateLimitResult

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canDelete) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const fileId = String(searchParams.get('fileId') || '').trim()
  const folderPathRaw = String(searchParams.get('folderPath') || '').trim()
  const folderPath = normalizeProjectUploadRelativePath(folderPathRaw)

  if (!fileId && !folderPath) {
    return NextResponse.json({ error: 'fileId or folderPath is required' }, { status: 400 })
  }

  if (fileId) {
    const result = await deleteUploadFile({ projectId: access.project.id, fileId })
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Failed to delete file' }, { status: result.status || 500 })
    }
    // Notify open share pages / admin views so the deletion reflects live.
    await publishProjectEvent(access.project.id, 'upload')
    return NextResponse.json({ success: true })
  }

  const result = await deleteUploadFolderTree({ projectId: access.project.id, folderPath })
  if (!result.ok) {
    return NextResponse.json({ error: result.error || 'Failed to delete folder' }, { status: result.status || 500 })
  }

  // Notify open share pages / admin views so the deletion reflects live.
  await publishProjectEvent(access.project.id, 'upload')

  return NextResponse.json({ success: true })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    `share-uploads-rename:${token}`,
  )
  if (rateLimitResult) return rateLimitResult

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canDelete) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const folderPath = normalizeProjectUploadRelativePath(String(body?.folderPath || '').trim())
  const result = await renameUploadFolder({
    projectId: access.project.id,
    folderPath,
    folderName: String(body?.folderName || ''),
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error || 'Failed to rename folder' }, { status: result.status || 500 })
  }

  // Notify open share pages / admin views so the rename reflects live.
  await publishProjectEvent(access.project.id, 'upload')

  return NextResponse.json({
    success: true,
    folderPath: result.nextFolderPath,
  })
}
