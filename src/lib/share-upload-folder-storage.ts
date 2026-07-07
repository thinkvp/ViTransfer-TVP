import crypto from 'crypto'
import * as fs from 'fs'
import { prisma } from '@/lib/db'
import {
  buildProjectUploadFolderStoragePath,
  normalizeProjectUploadRelativePath,
  sanitizeStorageName,
} from '@/lib/project-storage-paths'
import { deleteFile, deleteDirectory, getFilePath, uploadFile } from '@/lib/storage'
import { isS3Mode } from '@/lib/s3-storage'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import {
  getStoredFileRecords,
  deleteStoredFilesForEntity,
  deleteStoredFilesByCriteria,
} from '@/lib/stored-file'

// Empty marker object written into a folder's storage path so an otherwise-empty
// folder still materialises on disk / in the bucket.
export const UPLOAD_FOLDER_MARKER = '.vitransfer_folder'

function getRandomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

/**
 * Materialise an upload folder in storage so it exists even while empty: writes an
 * empty marker object in S3 mode, or mkdir -p on local disk. Shared by the share and
 * admin folder-create routes.
 */
export async function ensureUploadFolderExistsInStorage(storagePath: string): Promise<void> {
  if (isS3Mode()) {
    const markerPath = `${storagePath}/${UPLOAD_FOLDER_MARKER}`
    await uploadFile(markerPath, Buffer.alloc(0), 0, 'application/octet-stream')
    return
  }

  const absolutePath = getFilePath(storagePath)
  await fs.promises.mkdir(absolutePath, { recursive: true })
}

/** Parent relative path of a folder path ("A/B/C" -> "A/B", "A" -> ""). */
export function getUploadFolderParentRelativePath(relativePath: string): string {
  const normalized = normalizeProjectUploadRelativePath(relativePath)
  if (!normalized) return ''
  const parts = normalized.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

export interface UploadMutationResult {
  ok: boolean
  status?: number
  error?: string
}

/**
 * Delete a single upload file plus every StoredFile derivative (original +
 * preview/timeline sprites). Shared by the share route and the admin route so the
 * physical-cleanup logic lives in exactly one place.
 */
export async function deleteUploadFile(params: {
  projectId: string
  fileId: string
}): Promise<UploadMutationResult> {
  const file = await prisma.shareUploadFile.findFirst({
    where: { id: params.fileId, projectId: params.projectId },
    select: { id: true, fileType: true },
  })

  if (!file) {
    return { ok: false, status: 404, error: 'File not found' }
  }

  // Pull every registered file for this upload (original + preview/timeline derivatives)
  // so we delete ALL of them, not just the ORIGINAL.
  const storedRecords = (await getStoredFileRecords('SHARE_UPLOAD_FILE', [file.id], {
    select: { fileRole: true, storagePath: true },
  })) as Array<{ fileRole: string; storagePath: string | null }>

  const physicalDeletes: Promise<unknown>[] = []
  for (const rec of storedRecords) {
    if (!rec.storagePath) continue
    physicalDeletes.push(
      (rec.fileRole === 'TIMELINE_SPRITES' ? deleteDirectory(rec.storagePath) : deleteFile(rec.storagePath)).catch(() => undefined),
    )
  }
  await Promise.allSettled(physicalDeletes)

  await prisma.shareUploadFile.delete({ where: { id: file.id } })
  await deleteStoredFilesForEntity('SHARE_UPLOAD_FILE', file.id).catch(() => {})
  await recalculateAndStoreProjectTotalBytes(params.projectId)
  return { ok: true }
}

/**
 * Recursively delete an upload folder: all descendant folders + files, their
 * StoredFile rows and physical objects, and the folder storage markers. Shared by
 * the share route (client deletes) and the admin route.
 */
export async function deleteUploadFolderTree(params: {
  projectId: string
  folderPath: string
}): Promise<UploadMutationResult> {
  const folderPath = normalizeProjectUploadRelativePath(params.folderPath)
  if (!folderPath) {
    return { ok: false, status: 400, error: 'Invalid folderPath' }
  }

  const foldersToDelete = await prisma.shareUploadFolder.findMany({
    where: {
      projectId: params.projectId,
      OR: [
        { relativePath: folderPath },
        { relativePath: { startsWith: `${folderPath}/` } },
      ],
    },
    select: { id: true, storagePath: true },
  })

  const filesToDelete = await prisma.shareUploadFile.findMany({
    where: {
      projectId: params.projectId,
      OR: [
        { folderRelativePath: folderPath },
        { folderRelativePath: { startsWith: `${folderPath}/` } },
      ],
    },
    select: { id: true, fileType: true },
  })

  // Delete every registered file (original + preview/timeline derivatives) for the
  // uploads in this folder. Preview paths come from StoredFile (ID-keyed).
  const fileDeleteTasks: Promise<unknown>[] = []
  const folderFileIds = filesToDelete.map((f) => f.id)
  if (folderFileIds.length > 0) {
    const folderStored = (await getStoredFileRecords('SHARE_UPLOAD_FILE', folderFileIds, {
      select: { fileRole: true, storagePath: true },
    })) as Array<{ fileRole: string; storagePath: string | null }>
    for (const rec of folderStored) {
      if (!rec.storagePath) continue
      fileDeleteTasks.push(
        (rec.fileRole === 'TIMELINE_SPRITES' ? deleteDirectory(rec.storagePath) : deleteFile(rec.storagePath)).catch(() => undefined),
      )
    }
  }
  await Promise.allSettled(fileDeleteTasks)

  const folderIdsToDelete = foldersToDelete.map((folder) => folder.id)
  const uniqueFolderStoragePaths = [...new Set(foldersToDelete.map((folder) => folder.storagePath).filter(Boolean))]

  if (uniqueFolderStoragePaths.length > 0) {
    const siblingFolders = await prisma.shareUploadFolder.findMany({
      where: {
        projectId: params.projectId,
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

  const fileIdsToDelete = filesToDelete.map((f) => f.id)

  await prisma.$transaction([
    prisma.shareUploadFile.deleteMany({
      where: {
        projectId: params.projectId,
        OR: [
          { folderRelativePath: folderPath },
          { folderRelativePath: { startsWith: `${folderPath}/` } },
        ],
      },
    }),
    prisma.shareUploadFolder.deleteMany({
      where: {
        projectId: params.projectId,
        OR: [
          { relativePath: folderPath },
          { relativePath: { startsWith: `${folderPath}/` } },
        ],
      },
    }),
  ])

  if (fileIdsToDelete.length > 0) {
    await deleteStoredFilesByCriteria({
      entityType: 'SHARE_UPLOAD_FILE',
      entityIds: fileIdsToDelete,
    }).catch(() => {})
  }

  await recalculateAndStoreProjectTotalBytes(params.projectId)
  return { ok: true }
}

/**
 * Zero-copy rename of an upload folder subtree: remap logical relative paths for the
 * folder and every descendant folder/file in the DB, leaving physical storage keys
 * untouched. Shared by the share route and the admin route.
 */
export async function renameUploadFolder(params: {
  projectId: string
  folderPath: string
  folderName: string
}): Promise<UploadMutationResult & { nextFolderPath?: string }> {
  const folderPath = normalizeProjectUploadRelativePath(params.folderPath)
  const nextFolderName = sanitizeStorageName(params.folderName.trim())

  if (!folderPath) {
    return { ok: false, status: 400, error: 'folderPath is required' }
  }
  if (!nextFolderName) {
    return { ok: false, status: 400, error: 'folderName is required' }
  }

  const parentPath = getUploadFolderParentRelativePath(folderPath)
  const nextFolderPath = normalizeProjectUploadRelativePath(
    parentPath ? `${parentPath}/${nextFolderName}` : nextFolderName,
  )

  if (!nextFolderPath) {
    return { ok: false, status: 400, error: 'Invalid target folder path' }
  }

  if (nextFolderPath === folderPath) {
    return { ok: true, nextFolderPath }
  }

  const conflictingFolder = await prisma.shareUploadFolder.findFirst({
    where: {
      projectId: params.projectId,
      relativePath: nextFolderPath,
    },
    select: { id: true },
  })

  if (conflictingFolder) {
    return { ok: false, status: 409, error: 'A folder with that name already exists' }
  }

  const [folderRows, fileExists] = await Promise.all([
    prisma.shareUploadFolder.findMany({
      where: {
        projectId: params.projectId,
        OR: [
          { relativePath: folderPath },
          { relativePath: { startsWith: `${folderPath}/` } },
        ],
      },
      select: { id: true, relativePath: true },
    }),
    prisma.shareUploadFile.findFirst({
      where: {
        projectId: params.projectId,
        OR: [
          { folderRelativePath: folderPath },
          { folderRelativePath: { startsWith: `${folderPath}/` } },
        ],
      },
      select: { id: true },
    }),
  ])

  if (folderRows.length === 0 && !fileExists) {
    return { ok: false, status: 404, error: 'Folder not found' }
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
      WHERE "projectId" = ${params.projectId}
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

  return { ok: true, nextFolderPath }
}

export async function resolveUploadFolderStoragePath(params: {
  projectId: string
  projectStoragePath: string
  folderRelativePath: string
}): Promise<string> {
  const normalizedRelativePath = normalizeProjectUploadRelativePath(params.folderRelativePath)
  if (!normalizedRelativePath) {
    return buildProjectUploadFolderStoragePath(params.projectStoragePath, '')
  }

  const existingFolder = await prisma.shareUploadFolder.findUnique({
    where: {
      projectId_relativePath: {
        projectId: params.projectId,
        relativePath: normalizedRelativePath,
      },
    },
    select: { storagePath: true },
  })

  if (existingFolder?.storagePath) {
    return existingFolder.storagePath
  }

  const preferredStoragePath = buildProjectUploadFolderStoragePath(
    params.projectStoragePath,
    normalizedRelativePath,
  )

  const conflictingFolder = await prisma.shareUploadFolder.findFirst({
    where: {
      projectId: params.projectId,
      storagePath: preferredStoragePath,
    },
    select: { id: true },
  })

  if (!conflictingFolder) {
    return preferredStoragePath
  }

  const segments = normalizedRelativePath.split('/')
  const leaf = segments.pop() || 'folder'
  const parent = segments.join('/')

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidateLeaf = `${leaf}__${getRandomSuffix()}`
    const candidateRelativePath = parent ? `${parent}/${candidateLeaf}` : candidateLeaf
    const candidateStoragePath = buildProjectUploadFolderStoragePath(
      params.projectStoragePath,
      candidateRelativePath,
    )

    const candidateConflict = await prisma.shareUploadFolder.findFirst({
      where: {
        projectId: params.projectId,
        storagePath: candidateStoragePath,
      },
      select: { id: true },
    })

    if (!candidateConflict) {
      return candidateStoragePath
    }
  }

  return `${preferredStoragePath}__${Date.now().toString(36)}`
}
