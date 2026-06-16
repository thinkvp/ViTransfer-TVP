import * as fs from 'fs'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import {
  normalizeProjectUploadRelativePath,
  sanitizeStorageName,
} from '@/lib/project-storage-paths'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { deleteFile, getFilePath, uploadFile } from '@/lib/storage'
import { isS3Mode } from '@/lib/s3-storage'
import { resolveUploadFolderStoragePath } from '@/lib/share-upload-folder-storage'
import { resolveProjectStoragePath, resolveShareUploadAccess } from '@/lib/share-uploads'
import { getShareUploadPreviewStoragePath } from '@/lib/share-upload-video-thumbnail'
import { getStoredFilePathForProject, deleteStoredFile, deleteStoredFilesByCriteria } from '@/lib/stored-file'

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
  fileSize: string
  fileType: string
  createdAt: Date
  previewStatus: string | null
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
      select: { id: true, fileType: true },
    })

    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Get storage path from StoredFile
    const fileStoragePath = await getStoredFilePathForProject('SHARE_UPLOAD_FILE', file.id, 'ORIGINAL', access.project.id)

    const projectStoragePath = resolveProjectStoragePath(access.project)
    const thumbnailStoragePath = fileStoragePath ? getShareUploadPreviewStoragePath(projectStoragePath, fileStoragePath, file.fileType) : null

    if (fileStoragePath) {
      await deleteFile(fileStoragePath).catch(() => undefined)
    }
    if (thumbnailStoragePath) {
      await deleteFile(thumbnailStoragePath).catch(() => undefined)
    }
    await prisma.shareUploadFile.delete({ where: { id: file.id } })
    await deleteStoredFile('SHARE_UPLOAD_FILE', file.id, 'ORIGINAL').catch(() => {})
    await recalculateAndStoreProjectTotalBytes(access.project.id)
    return NextResponse.json({ success: true })
  }

  if (!folderPath) {
    return NextResponse.json({ error: 'Invalid folderPath' }, { status: 400 })
  }

  const foldersToDelete = await prisma.shareUploadFolder.findMany({
    where: {
      projectId: access.project.id,
      OR: [
        { relativePath: folderPath },
        { relativePath: { startsWith: `${folderPath}/` } },
      ],
    },
    select: { id: true, storagePath: true },
  })

  const filesToDelete = await prisma.shareUploadFile.findMany({
    where: {
      projectId: access.project.id,
      OR: [
        { folderRelativePath: folderPath },
        { folderRelativePath: { startsWith: `${folderPath}/` } },
      ],
    },
    select: { id: true, fileType: true },
  })

  // Get paths from StoredFile
  const fileDeleteTasks: Promise<unknown>[] = []
  const projectStoragePath = resolveProjectStoragePath(access.project)
  for (const file of filesToDelete) {
    const fileStoragePath = await getStoredFilePathForProject('SHARE_UPLOAD_FILE', file.id, 'ORIGINAL', access.project.id)
    if (fileStoragePath) {
      fileDeleteTasks.push(deleteFile(fileStoragePath))
      const thumbnailStoragePath = getShareUploadPreviewStoragePath(projectStoragePath, fileStoragePath, file.fileType)
      if (thumbnailStoragePath) {
        fileDeleteTasks.push(deleteFile(thumbnailStoragePath))
      }
    }
  }
  await Promise.allSettled(fileDeleteTasks)

  const folderIdsToDelete = foldersToDelete.map((folder) => folder.id)
  const uniqueFolderStoragePaths = [...new Set(foldersToDelete.map((folder) => folder.storagePath).filter(Boolean))]

  if (uniqueFolderStoragePaths.length > 0) {
    const siblingFolders = await prisma.shareUploadFolder.findMany({
      where: {
        projectId: access.project.id,
        storagePath: { in: uniqueFolderStoragePaths },
        NOT: { id: { in: folderIdsToDelete } },
      },
      select: { storagePath: true },
    })
    const sharedStoragePathSet = new Set(siblingFolders.map((folder) => folder.storagePath))

    const markerDeleteTasks = uniqueFolderStoragePaths
      .filter((storagePath) => !sharedStoragePathSet.has(storagePath))
      .map((storagePath) => deleteFile(`${storagePath}/${UPLOAD_FOLDER_MARKER}`))

    await Promise.allSettled(markerDeleteTasks)
  }

  // Collect file IDs for StoredFile cleanup before deletion
  const fileIdsToDelete = filesToDelete.map(f => f.id)

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

  // Clean up StoredFile rows for deleted files
  if (fileIdsToDelete.length > 0) {
    await deleteStoredFilesByCriteria({
      entityType: 'SHARE_UPLOAD_FILE',
      entityIds: fileIdsToDelete,
    }).catch(() => {})
  }

  await recalculateAndStoreProjectTotalBytes(access.project.id)

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
  const nextFolderName = sanitizeStorageName(String(body?.folderName || '').trim())

  if (!folderPath) {
    return NextResponse.json({ error: 'folderPath is required' }, { status: 400 })
  }

  if (!nextFolderName) {
    return NextResponse.json({ error: 'folderName is required' }, { status: 400 })
  }

  const parentPath = getParentRelativePath(folderPath)
  const nextFolderPath = normalizeProjectUploadRelativePath(
    parentPath ? `${parentPath}/${nextFolderName}` : nextFolderName,
  )

  if (!nextFolderPath) {
    return NextResponse.json({ error: 'Invalid target folder path' }, { status: 400 })
  }

  if (nextFolderPath === folderPath) {
    return NextResponse.json({ success: true, folderPath: nextFolderPath })
  }

  const conflictingFolder = await prisma.shareUploadFolder.findFirst({
    where: {
      projectId: access.project.id,
      relativePath: nextFolderPath,
    },
    select: { id: true },
  })

  if (conflictingFolder) {
    return NextResponse.json({ error: 'A folder with that name already exists' }, { status: 409 })
  }

  const [folderRows, fileExists] = await Promise.all([
    prisma.shareUploadFolder.findMany({
      where: {
        projectId: access.project.id,
        OR: [
          { relativePath: folderPath },
          { relativePath: { startsWith: `${folderPath}/` } },
        ],
      },
      select: { id: true, relativePath: true },
    }),
    prisma.shareUploadFile.findFirst({
      where: {
        projectId: access.project.id,
        OR: [
          { folderRelativePath: folderPath },
          { folderRelativePath: { startsWith: `${folderPath}/` } },
        ],
      },
      select: { id: true },
    }),
  ])

  if (folderRows.length === 0 && !fileExists) {
    return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
  }

  const prefixLength = folderPath.length

  await prisma.$transaction(async (tx) => {
    // Zero-copy rename: remap logical folder paths in DB. Keep physical storage keys unchanged.
    await tx.$executeRaw`
      UPDATE "ShareUploadFile"
      SET "folderRelativePath" = CASE
        WHEN "folderRelativePath" = ${folderPath} THEN ${nextFolderPath}
        ELSE ${nextFolderPath} || REPLACE("folderRelativePath", ${folderPath}, '')
      END
      WHERE "projectId" = ${access.project.id}
        AND (
          "folderRelativePath" = ${folderPath}
          OR "folderRelativePath" LIKE ${`${folderPath}/%`}
        )
    `

    for (const folder of folderRows) {
      const suffix = folder.relativePath === folderPath
        ? ''
        : folder.relativePath.slice(prefixLength)
      const nextRelativePath = `${nextFolderPath}${suffix}`
      const nextName = nextRelativePath.split('/').pop() || nextFolderName

      await tx.shareUploadFolder.update({
        where: { id: folder.id },
        data: {
          relativePath: nextRelativePath,
          folderName: nextName,
        },
      })
    }
  })

  return NextResponse.json({
    success: true,
    folderPath: nextFolderPath,
  })
}
