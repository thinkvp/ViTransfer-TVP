import { getFilePath } from '@/lib/storage'
import { buildAlbumZipStoragePath as buildCanonicalAlbumZipStoragePath } from '@/lib/project-storage-paths'
import { isS3Mode, s3FileExists } from '@/lib/s3-storage'
import fs from 'fs'

export type AlbumZipVariant = 'full' | 'social'

function sanitizeAlbumZipName(albumName: string): string {
  const sanitized = albumName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\.-]+|[_\.-]+$/g, '')

  return sanitized || 'Album'
}

export function getAlbumZipFileName(params: { albumName: string; variant: AlbumZipVariant }): string {
  const { albumName, variant } = params
  const baseName = sanitizeAlbumZipName(albumName)
  const suffix = variant === 'social' ? 'Social_Sized' : 'Full_Res'
  return `${baseName}_${suffix}.zip`
}

export function getAlbumZipJobId(params: { albumId: string; variant: AlbumZipVariant }): string {
  const { albumId, variant } = params
  return `album-photo-zip-${variant}-${albumId}`
}

export function getAlbumZipStoragePath(params: {
  projectId?: string
  albumId?: string
  projectStoragePath?: string
  albumFolderName?: string
  albumName: string
  variant: AlbumZipVariant
}): string {
  const { projectId, albumId, projectStoragePath, albumFolderName, albumName, variant } = params
  const fileName = getAlbumZipFileName({ albumName, variant })
  if (projectStoragePath && albumFolderName) {
    return buildCanonicalAlbumZipStoragePath(projectStoragePath, albumFolderName, albumName, variant)
  }
  return `projects/${projectId}/albums/${albumId}/zips/${fileName}`
}

export function getAlbumZipStoragePaths(params: {
  projectId?: string
  albumId?: string
  projectStoragePath?: string
  albumFolderName?: string
  albumName: string
}): { full: string; social: string } {
  const { projectId, albumId, projectStoragePath, albumFolderName, albumName } = params
  return {
    full: getAlbumZipStoragePath({
      projectId,
      albumId,
      projectStoragePath,
      albumFolderName,
      albumName,
      variant: 'full',
    }),
    social: getAlbumZipStoragePath({
      projectId,
      albumId,
      projectStoragePath,
      albumFolderName,
      albumName,
      variant: 'social',
    }),
  }
}

export async function albumZipExists(storagePath: string): Promise<boolean> {
  try {
    if (isS3Mode()) {
      return await s3FileExists(storagePath)
    }
    const fullPath = getFilePath(storagePath)
    return fs.existsSync(fullPath)
  } catch {
    return false
  }
}
