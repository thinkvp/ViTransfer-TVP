import { existsSync, statSync } from 'fs'
import { getFilePath } from '@/lib/storage'
import {
  createTemporaryDropboxLink,
  isDropboxStoragePath,
  materializeDropboxPathToTempFile,
  stripDropboxStoragePrefix,
} from '@/lib/storage-provider-dropbox'

export class DropboxPreferredDownloadError extends Error {
  constructor(message: string = 'Dropbox download is unavailable') {
    super(message)
    this.name = 'DropboxPreferredDownloadError'
  }
}

const DROPBOX_LINK_RETRY_ATTEMPTS = 3
const DROPBOX_LINK_RETRY_DELAYS_MS = [150, 350]

export type StorageLocation =
  | { provider: 'local'; path: string }
  | { provider: 'dropbox'; path: string }

export function parseStorageLocation(rawPath: string): StorageLocation {
  if (isDropboxStoragePath(rawPath)) {
    return { provider: 'dropbox', path: rawPath }
  }

  return { provider: 'local', path: rawPath }
}

/**
 * Try to resolve a Dropbox storage path to a local file first.
 * Returns the absolute path if a local copy exists, null otherwise.
 */
function tryResolveDropboxPathLocally(rawPath: string): string | null {
  try {
    const localRelPath = stripDropboxStoragePrefix(rawPath)
    const localAbsPath = getFilePath(localRelPath)
    if (existsSync(localAbsPath)) {
      const stat = statSync(localAbsPath)
      if (stat.isFile() && stat.size > 0) {
        return localAbsPath
      }
    }
  } catch {
    // local copy not available
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function createTemporaryDropboxLinkWithRetry(rawPath: string, dropboxPath?: string | null): Promise<string> {
  let lastError: unknown = null

  for (let attempt = 0; attempt < DROPBOX_LINK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await createTemporaryDropboxLink(rawPath, dropboxPath)
    } catch (error) {
      lastError = error
      if (attempt < DROPBOX_LINK_RETRY_ATTEMPTS - 1) {
        const delayMs = DROPBOX_LINK_RETRY_DELAYS_MS[attempt] ?? DROPBOX_LINK_RETRY_DELAYS_MS[DROPBOX_LINK_RETRY_DELAYS_MS.length - 1] ?? 0
        if (delayMs > 0) {
          await sleep(delayMs)
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to create Dropbox download link')
}

export async function resolveStorageDownloadTarget(rawPath: string, options?: { preferDropbox?: boolean; dropboxPath?: string | null }): Promise<
  | { kind: 'local-file'; absolutePath: string }
  | { kind: 'redirect'; url: string }
> {
  const location = parseStorageLocation(rawPath)

  if (location.provider === 'local' && options?.preferDropbox && options.dropboxPath) {
    try {
      return {
        kind: 'redirect',
        url: await createTemporaryDropboxLinkWithRetry(rawPath, options.dropboxPath),
      }
    } catch (error: any) {
      throw new DropboxPreferredDownloadError(
        error?.message || 'Failed to create Dropbox download link'
      )
    }
  }

  if (location.provider === 'local') {
    return { kind: 'local-file', absolutePath: getFilePath(location.path) }
  }

  // For Dropbox-stored files: prefer serving from Dropbox directly (saves server bandwidth)
  if (options?.preferDropbox) {
    try {
      return {
        kind: 'redirect',
        url: await createTemporaryDropboxLinkWithRetry(location.path, options.dropboxPath),
      }
    } catch (error: any) {
      throw new DropboxPreferredDownloadError(
        error?.message || 'Failed to create Dropbox download link'
      )
    }
  }

  // Try local copy (faster, allows Content-Disposition control)
  const localPath = tryResolveDropboxPathLocally(location.path)
  if (localPath) {
    return { kind: 'local-file', absolutePath: localPath }
  }

  // Fallback to Dropbox redirect
  return {
    kind: 'redirect',
    url: await createTemporaryDropboxLinkWithRetry(location.path, options?.dropboxPath),
  }
}

export async function materializeStoragePathToLocalFile(params: {
  rawPath: string
  tempDir: string
  suggestedName: string
}): Promise<{ localPath: string; isTemporary: boolean }> {
  const location = parseStorageLocation(params.rawPath)

  if (location.provider === 'local') {
    return { localPath: getFilePath(location.path), isTemporary: false }
  }

  // Check for local copy first (kept after Dropbox upload for fast processing)
  const localPath = tryResolveDropboxPathLocally(location.path)
  if (localPath) {
    return { localPath, isTemporary: false }
  }

  // Download from Dropbox as fallback
  return {
    localPath: await materializeDropboxPathToTempFile({
      rawPath: location.path,
      tempDir: params.tempDir,
      suggestedName: params.suggestedName,
    }),
    isTemporary: true,
  }
}