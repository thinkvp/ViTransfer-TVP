import { getFilePath } from '@/lib/storage'
import fs from 'fs'

export type AlbumZipVariant = 'full' | 'social'

export function getAlbumZipJobId(params: { albumId: string; variant: AlbumZipVariant }): string {
  const { albumId, variant } = params
  return `album-photo-zip-${variant}-${albumId}`
}

export function getAlbumZipStoragePath(params: {
  projectId: string
  albumId: string
  variant: AlbumZipVariant
}): string {
  const { projectId, albumId, variant } = params
  const fileName = variant === 'social' ? 'photos_social.zip' : 'photos_full.zip'
  return `projects/${projectId}/albums/${albumId}/zips/${fileName}`
}

export function albumZipExists(storagePath: string): boolean {
  try {
    const fullPath = getFilePath(storagePath)
    return fs.existsSync(fullPath)
  } catch {
    return false
  }
}
