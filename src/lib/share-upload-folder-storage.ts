import crypto from 'crypto'
import { prisma } from '@/lib/db'
import {
  buildProjectUploadFolderStoragePath,
  normalizeProjectUploadRelativePath,
} from '@/lib/project-storage-paths'

function getRandomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
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
