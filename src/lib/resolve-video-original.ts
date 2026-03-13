import { existsSync } from 'fs'
import { getFilePath } from '@/lib/storage'
import { buildProjectStorageRoot, buildVideoOriginalStoragePath } from '@/lib/project-storage-paths'
import { isDropboxStoragePath, stripDropboxStoragePrefix } from '@/lib/storage-provider-dropbox'

/**
 * Check whether a storage path (local or dropbox:-prefixed) exists on the local filesystem.
 *
 * Uses getFilePath() which applies the legacy project-redirect layer, so explicit
 * YYYY-MM path probing is unnecessary.
 */
export function storagePathExistsLocal(storagePath: string | null | undefined): boolean {
  if (!storagePath) return false

  try {
    const localPath = isDropboxStoragePath(storagePath)
      ? stripDropboxStoragePrefix(storagePath)
      : storagePath
    return existsSync(getFilePath(localPath))
  } catch {
    return false
  }
}

export type VideoOriginalContext = {
  id: string
  name: string
  versionLabel: string
  originalFileName: string
  originalStoragePath: string
  storageFolderName: string | null
  projectId: string
  project: {
    title: string
    companyName: string | null
    storagePath: string | null
    client: { name: string } | null
  }
}

/**
 * Resolve the actual on-disk path for a video's original file.
 *
 * Checks in order:
 *  1. The stored originalStoragePath (with dropbox: stripped if present)
 *  2. The canonical path rebuilt from project/video/version metadata
 *  3. Legacy project-ID based roots (the redirect layer in storage.ts
 *     transparently resolves projects/<id>/... to projects/YYYY-MM/<id>/...)
 *
 * Returns the first candidate that exists on disk, or null if none found.
 */
export function resolveVideoOriginalPath(video: VideoOriginalContext): string | null {
  const localCurrentPath = isDropboxStoragePath(video.originalStoragePath)
    ? stripDropboxStoragePrefix(video.originalStoragePath)
    : video.originalStoragePath

  const projectStoragePath = video.project.storagePath
    || buildProjectStorageRoot(
      video.project.client?.name || video.project.companyName || 'Client',
      video.project.title,
    )

  const canonicalOriginalPath = buildVideoOriginalStoragePath(
    projectStoragePath,
    video.storageFolderName || video.name,
    video.versionLabel,
    video.originalFileName,
  )

  // Legacy project roots — the storage redirect layer in storage.ts resolves
  // projects/<id>/... to the physical YYYY-MM location automatically, so we
  // only need the logical legacy root here.
  const legacyProjectRoot = `projects/${video.projectId}`
  const legacyVideoFolderCandidates = [video.storageFolderName || video.name, video.id]
  const legacyCandidates = [
    ...legacyVideoFolderCandidates.map(
      (folderName) => `${legacyProjectRoot}/videos/${folderName}/${video.originalFileName}`,
    ),
    `${legacyProjectRoot}/videos/${video.originalFileName}`,
  ]

  const seen = new Set<string>()
  const candidates: string[] = []
  for (const raw of [localCurrentPath, canonicalOriginalPath, ...legacyCandidates]) {
    const value = (raw || '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    candidates.push(value)
  }

  for (const candidate of candidates) {
    if (storagePathExistsLocal(candidate)) {
      return candidate
    }
  }

  return null
}
