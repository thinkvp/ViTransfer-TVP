import * as fs from 'fs'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import {
  buildProjectUploadFolderStoragePath,
  normalizeProjectUploadRelativePath,
  sanitizeStorageName,
} from '@/lib/project-storage-paths'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { deleteDirectory, deleteFile, getFilePath, uploadFile } from '@/lib/storage'
import { isS3Mode } from '@/lib/s3-storage'
import { resolveProjectStoragePath, resolveShareUploadAccess } from '@/lib/share-uploads'
import { getShareUploadPreviewStoragePath } from '@/lib/share-upload-video-thumbnail'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UPLOAD_FOLDER_MARKER = '.vitransfer_folder'

interface FolderListItem {
  id: string
  relativePath: string
  folderName: string
  createdAt: Date
}

interface FileListItem {
  id: string
  folderRelativePath: string
  fileName: string
  fileSize: bigint
  fileType: string
  createdAt: Date
}

function getParentRelativePath(relativePath: string): string {
  const normalized = normalizeProjectUploadRelativePath(relativePath)
  if (!normalized) return ''
  const parts = normalized.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

async function ensureFolderExistsInStorage(storagePath: string): Promise<void> {
  if (isS3Mode()) {
    const markerPath = `${storagePath}/${UPLOAD_FOLDER_MARKER}`
    await uploadFile(markerPath, Buffer.alloc(0), 0, 'application/octet-stream')
    return
  }

  const absolutePath = getFilePath(storagePath)
  await fs.promises.mkdir(absolutePath, { recursive: true })
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
        fileSize: true,
        fileType: true,
        createdAt: true,
      },
    }),
  ])

  const folderItems = folders.map((folder: FolderListItem) => ({
    ...folder,
    parentRelativePath: getParentRelativePath(folder.relativePath),
  }))

  const fileItems = files.map((file: FileListItem) => ({
    ...file,
    fileSize: Number(file.fileSize),
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
  const storagePath = buildProjectUploadFolderStoragePath(projectStoragePath, relativePath)

  try {
    await ensureFolderExistsInStorage(storagePath)
  } catch (error) {
    console.error('[SHARE UPLOADS] Failed to create storage folder:', error)
    return NextResponse.json({ error: 'Failed to create folder in storage' }, { status: 500 })
  }

  const folder = await prisma.shareUploadFolder.upsert({
    where: {
      projectId_relativePath: {
        projectId: access.project.id,
        relativePath,
      },
    },
    update: {
      folderName: safeFolderName,
      storagePath,
      createdByName: access.isAdmin ? 'Admin' : 'Client',
    },
    create: {
      projectId: access.project.id,
      relativePath,
      folderName: safeFolderName,
      storagePath,
      createdByName: access.isAdmin ? 'Admin' : 'Client',
    },
    select: {
      id: true,
      relativePath: true,
      folderName: true,
      storagePath: true,
      createdAt: true,
    },
  })

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
    const file = await prisma.shareUploadFile.findFirst({
      where: { id: fileId, projectId: access.project.id },
      select: { id: true, storagePath: true, fileType: true },
    })

    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    const thumbnailStoragePath = getShareUploadPreviewStoragePath(file.storagePath, file.fileType)

    await deleteFile(file.storagePath).catch(() => undefined)
    if (thumbnailStoragePath) {
      await deleteFile(thumbnailStoragePath).catch(() => undefined)
    }
    await prisma.shareUploadFile.delete({ where: { id: file.id } })
    await recalculateAndStoreProjectTotalBytes(access.project.id)
    return NextResponse.json({ success: true })
  }

  if (!folderPath) {
    return NextResponse.json({ error: 'Invalid folderPath' }, { status: 400 })
  }

  const projectStoragePath = resolveProjectStoragePath(access.project)
  const folderStoragePath = buildProjectUploadFolderStoragePath(projectStoragePath, folderPath)

  const filesToDelete = await prisma.shareUploadFile.findMany({
    where: {
      projectId: access.project.id,
      OR: [
        { folderRelativePath: folderPath },
        { folderRelativePath: { startsWith: `${folderPath}/` } },
      ],
    },
    select: { id: true, storagePath: true },
  })

  await Promise.allSettled(filesToDelete.map((file) => deleteFile(file.storagePath)))

  await deleteDirectory(folderStoragePath).catch(() => undefined)
  await deleteFile(`${folderStoragePath}/${UPLOAD_FOLDER_MARKER}`).catch(() => undefined)

  await prisma.$transaction([
    prisma.shareUploadFile.deleteMany({
      where: {
        projectId: access.project.id,
        OR: [
          { folderRelativePath: folderPath },
          { folderRelativePath: { startsWith: `${folderPath}/` } },
        ],
      },
    }),
    prisma.shareUploadFolder.deleteMany({
      where: {
        projectId: access.project.id,
        OR: [
          { relativePath: folderPath },
          { relativePath: { startsWith: `${folderPath}/` } },
        ],
      },
    }),
  ])

  await recalculateAndStoreProjectTotalBytes(access.project.id)

  return NextResponse.json({ success: true })
}
