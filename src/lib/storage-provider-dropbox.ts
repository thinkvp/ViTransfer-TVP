import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as NodeReadableStream } from 'stream/web'

const DROPBOX_PREFIX = 'dropbox:'
const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2'
const DROPBOX_CONTENT_BASE = 'https://content.dropboxapi.com/2'
const DROPBOX_SIMPLE_UPLOAD_LIMIT_BYTES = 150 * 1024 * 1024
const DROPBOX_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024

type DropboxTokenCache = {
  accessToken: string
  expiresAt: number
} | null

type NodeRequestInit = RequestInit & {
  duplex?: 'half'
}

export type DropboxUploadProgressCallback = (uploadedBytes: number, totalBytes: number) => void

let tokenCache: DropboxTokenCache = null

/**
 * Sanitize a name for use as a Dropbox folder or file name segment.
 * Replaces characters that are invalid in Dropbox paths.
 */
export function sanitizeDropboxName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.\s]+|[_.\s]+$/g, '')

  return sanitized || 'Untitled'
}

/**
 * Build a human-friendly Dropbox path relative to root from individual segments.
 * E.g. buildDropboxRelPath('My Project', 'Interview', 'v1 - clip.mp4')
 *   → 'My Project/Interview/v1 - clip.mp4'
 */
export function buildDropboxRelPath(...segments: string[]): string {
  return segments.filter(Boolean).join('/')
}

/**
 * Convert a relative Dropbox path (without root) to a full Dropbox API path.
 * Applies DROPBOX_ROOT_PATH and ensures the path starts with '/'.
 */
export function dropboxRelPathToApiPath(relPath: string): string {
  const root = normalizeDropboxRootPath()
  const fullPath = path.posix.join(root || '/', relPath)
  return fullPath.startsWith('/') ? fullPath : `/${fullPath}`
}

export function isDropboxStorageConfigured(): boolean {
  return Boolean(
    process.env.DROPBOX_APP_KEY?.trim()
    && process.env.DROPBOX_APP_SECRET?.trim()
    && process.env.DROPBOX_REFRESH_TOKEN?.trim()
  )
}

function getDropboxEnv(name: 'DROPBOX_APP_KEY' | 'DROPBOX_APP_SECRET' | 'DROPBOX_REFRESH_TOKEN'): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not configured`)
  }
  return value
}

function sanitizeTempName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file.bin'
}

export function isDropboxStoragePath(rawPath: string): boolean {
  return rawPath.startsWith(DROPBOX_PREFIX)
}

export function stripDropboxStoragePrefix(rawPath: string): string {
  if (!rawPath.startsWith(DROPBOX_PREFIX)) return rawPath
  return rawPath.slice(DROPBOX_PREFIX.length).replace(/^\/+/, '')
}

function normalizeDropboxRootPath(): string {
  const rawRoot = process.env.DROPBOX_ROOT_PATH?.trim()
  if (!rawRoot) return ''

  const normalized = rawRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return ''

  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function toDropboxApiPath(rawPath: string): string {
  const stripped = stripDropboxStoragePrefix(rawPath).trim().replace(/\\/g, '/')
  const relative = stripped.replace(/^\/+/, '')
  const root = normalizeDropboxRootPath()

  // Strip collision-avoidance prefixes from the filename so Dropbox stores
  // files with clean, human-friendly names (e.g. "My Video.mp4" instead of
  // "original-1773178786455-My Video.mp4").
  const lastSlash = relative.lastIndexOf('/')
  const dir = lastSlash >= 0 ? relative.slice(0, lastSlash + 1) : ''
  const filename = lastSlash >= 0 ? relative.slice(lastSlash + 1) : relative
  const cleanFilename = filename.replace(/^(?:original|asset|photo)-\d+-/, '')
  const cleanRelative = dir + (cleanFilename || filename)

  const fullPath = path.posix.join(root || '/', cleanRelative)
  return fullPath.startsWith('/') ? fullPath : `/${fullPath}`
}

export function toDropboxStoragePath(rawPath: string): string {
  const stripped = stripDropboxStoragePrefix(rawPath).trim().replace(/\\/g, '/')
  const relative = stripped.replace(/^\/+/, '')
  return `${DROPBOX_PREFIX}/${relative}`
}

function toDropboxRelativePath(rawPath: string): string {
  return stripDropboxStoragePrefix(rawPath).trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

async function fetchDropboxAccessToken(): Promise<string> {
  const now = Date.now()
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken
  }

  const appKey = getDropboxEnv('DROPBOX_APP_KEY')
  const appSecret = getDropboxEnv('DROPBOX_APP_SECRET')
  const refreshToken = getDropboxEnv('DROPBOX_REFRESH_TOKEN')
  const credentials = Buffer.from(`${appKey}:${appSecret}`).toString('base64')

  const response = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Failed to refresh Dropbox access token (${response.status}): ${errorText}`)
  }

  const payload = await response.json() as { access_token: string; expires_in?: number }
  const expiresInSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 14_400

  console.log(`[DROPBOX] Access token refreshed, expires in ${expiresInSeconds}s`)

  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: now + expiresInSeconds * 1000,
  }

  return payload.access_token
}

async function callDropboxJson<T>(endpoint: string, body: unknown): Promise<T> {
  const accessToken = await fetchDropboxAccessToken()
  const response = await fetch(`${DROPBOX_API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Dropbox API ${endpoint} failed (${response.status}): ${errorText}`)
  }

  return response.json() as Promise<T>
}

async function callDropboxContent(
  endpoint: string,
  apiArg: unknown,
  body?: BodyInit | null,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const accessToken = await fetchDropboxAccessToken()
  const requestInit: NodeRequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify(apiArg),
      ...(extraHeaders || {}),
    },
    body,
    duplex: body ? 'half' : undefined,
  }

  return fetch(`${DROPBOX_CONTENT_BASE}${endpoint}`, requestInit)
}

export async function createTemporaryDropboxLink(rawPath: string, dropboxRelPath?: string | null): Promise<string> {
  const apiPath = dropboxRelPath ? dropboxRelPathToApiPath(dropboxRelPath) : toDropboxApiPath(rawPath)
  const payload = await callDropboxJson<{ link: string }>('/files/get_temporary_link', {
    path: apiPath,
  })
  return payload.link
}

function getDropboxParentRelPath(relPath: string): string | null {
  const normalized = relPath.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!normalized) return null
  const parent = path.posix.dirname(normalized)
  if (!parent || parent === '.' || parent === '/') return null
  return parent
}

async function deleteDropboxApiPath(apiPath: string): Promise<boolean> {
  const accessToken = await fetchDropboxAccessToken()
  const response = await fetch(`${DROPBOX_API_BASE}/files/delete_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: apiPath }),
  })

  if (response.ok) return true

  const errorText = await response.text().catch(() => '')
  if (response.status === 409 && /not_found/i.test(errorText)) return false

  throw new Error(`Dropbox delete failed (${response.status}): ${errorText}`)
}

async function isDropboxFolderEmpty(relPath: string): Promise<boolean | null> {
  try {
    const payload = await callDropboxJson<{ entries?: unknown[] }>('/files/list_folder', {
      path: dropboxRelPathToApiPath(relPath),
      recursive: false,
      include_deleted: false,
      limit: 1,
    })
    return (payload.entries || []).length === 0
  } catch (err: any) {
    if (typeof err?.message === 'string' && /(not_found|not_folder)/i.test(err.message)) {
      return null
    }
    throw err
  }
}

async function cleanupDropboxEmptyParents(relPath: string): Promise<void> {
  let parentRelPath = getDropboxParentRelPath(relPath)

  while (parentRelPath) {
    const empty = await isDropboxFolderEmpty(parentRelPath)
    if (empty !== true) return

    const deleted = await deleteDropboxApiPath(dropboxRelPathToApiPath(parentRelPath))
    if (!deleted) return

    console.log(`[DROPBOX] Deleted empty folder: ${dropboxRelPathToApiPath(parentRelPath)}`)
    parentRelPath = getDropboxParentRelPath(parentRelPath)
  }
}

export async function deleteDropboxFile(rawPath: string, dropboxRelPath?: string | null): Promise<void> {
  const apiPath = dropboxRelPath ? dropboxRelPathToApiPath(dropboxRelPath) : toDropboxApiPath(rawPath)
  const cleanupRelPath = dropboxRelPath || toDropboxRelativePath(rawPath)
  console.log(`[DROPBOX] Deleting file: ${apiPath}`)
  const deleted = await deleteDropboxApiPath(apiPath)
  if (!deleted) return
  await cleanupDropboxEmptyParents(cleanupRelPath)
}

/**
 * Move/rename a file or folder on Dropbox.
 * Both paths are relative to DROPBOX_ROOT_PATH.
 * Silently succeeds if the source path does not exist.
 */
export async function moveDropboxPath(fromRelPath: string, toRelPath: string): Promise<void> {
  const fromApiPath = dropboxRelPathToApiPath(fromRelPath)
  const toApiPath = dropboxRelPathToApiPath(toRelPath)
  console.log(`[DROPBOX] Moving: ${fromApiPath} → ${toApiPath}`)

  try {
    await callDropboxJson('/files/move_v2', {
      from_path: fromApiPath,
      to_path: toApiPath,
      autorename: false,
      allow_ownership_transfer: false,
    })
  } catch (err: any) {
    // Silently ignore if source path doesn't exist (already moved or deleted)
    if (err?.message && /not_found/i.test(err.message)) {
      console.log(`[DROPBOX] Source path not found, skipping move: ${fromApiPath}`)
      return
    }
    throw err
  }

  await cleanupDropboxEmptyParents(fromRelPath)
}

export async function materializeDropboxPathToTempFile(params: {
  rawPath: string
  tempDir: string
  suggestedName: string
}): Promise<string> {
  const { rawPath, tempDir, suggestedName } = params
  await fs.promises.mkdir(tempDir, { recursive: true })

  const tempName = `${Date.now()}-${crypto.randomUUID()}-${sanitizeTempName(suggestedName)}`
  const tempPath = path.join(tempDir, tempName)
  const response = await callDropboxContent('/files/download', { path: toDropboxApiPath(rawPath) }, null)

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Failed to download Dropbox file (${response.status}): ${errorText}`)
  }

  const output = fs.createWriteStream(tempPath)
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), output)
  return tempPath
}

async function uploadSmallFileToDropbox(sourceAbsPath: string, apiPath: string): Promise<void> {
  const accessToken = await fetchDropboxAccessToken()
  const fileBuffer = await fs.promises.readFile(sourceAbsPath)
  const response = await fetch(`${DROPBOX_CONTENT_BASE}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({
        path: apiPath,
        mode: 'overwrite',
        autorename: false,
        mute: true,
      }),
      'Content-Type': 'application/octet-stream',
    },
    body: fileBuffer,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Dropbox simple upload failed (${response.status}): ${errorText}`)
  }
}

async function uploadLargeFileToDropboxWithProgress(
  sourceAbsPath: string,
  apiPath: string,
  onProgress?: DropboxUploadProgressCallback,
): Promise<void> {
  const handle = await fs.promises.open(sourceAbsPath, 'r')
  let sessionId: string | null = null
  let offset = 0

  try {
    const stats = await handle.stat()

    while (offset < stats.size) {
      const remaining = stats.size - offset
      const chunkLength = Math.min(DROPBOX_UPLOAD_CHUNK_SIZE, remaining)
      const chunkBuffer = Buffer.alloc(chunkLength)
      const { bytesRead } = await handle.read(chunkBuffer, 0, chunkLength, offset)
      const payload = chunkBuffer.subarray(0, bytesRead)

      if (!sessionId) {
        const response = await callDropboxContent(
          '/files/upload_session/start',
          { close: false },
          payload,
          { 'Content-Type': 'application/octet-stream' },
        )

        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          throw new Error(`Dropbox upload session start failed (${response.status}): ${errorText}`)
        }

        const body = await response.json() as { session_id: string }
        sessionId = body.session_id
      } else if (offset + bytesRead >= stats.size) {
        const response = await callDropboxContent(
          '/files/upload_session/finish',
          {
            cursor: { session_id: sessionId, offset },
            commit: {
              path: apiPath,
              mode: 'overwrite',
              autorename: false,
              mute: true,
            },
          },
          payload,
          { 'Content-Type': 'application/octet-stream' },
        )

        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          throw new Error(`Dropbox upload session finish failed (${response.status}): ${errorText}`)
        }
      } else {
        const response = await callDropboxContent(
          '/files/upload_session/append_v2',
          {
            cursor: { session_id: sessionId, offset },
            close: false,
          },
          payload,
          { 'Content-Type': 'application/octet-stream' },
        )

        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          throw new Error(`Dropbox upload session append failed (${response.status}): ${errorText}`)
        }
      }

      offset += bytesRead
      onProgress?.(offset, stats.size)
    }
  } finally {
    await handle.close()
  }
}

export async function uploadLocalFileToDropboxPath(sourceAbsPath: string, rawPath: string, dropboxRelPath?: string | null): Promise<void> {
  const stats = await fs.promises.stat(sourceAbsPath)
  if (!stats.isFile()) {
    throw new Error('Dropbox upload source must be a file')
  }

  const apiPath = dropboxRelPath ? dropboxRelPathToApiPath(dropboxRelPath) : toDropboxApiPath(rawPath)
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1)
  console.log(`[DROPBOX] Starting upload (${sizeMB} MB) → ${apiPath}`)

  if (stats.size <= DROPBOX_SIMPLE_UPLOAD_LIMIT_BYTES) {
    await uploadSmallFileToDropbox(sourceAbsPath, apiPath)
    return
  }

  await uploadLargeFileToDropboxWithProgress(sourceAbsPath, apiPath)
}

export async function uploadLocalFileToDropboxPathWithProgress(
  sourceAbsPath: string,
  rawPath: string,
  onProgress?: DropboxUploadProgressCallback,
  dropboxRelPath?: string | null,
): Promise<void> {
  const stats = await fs.promises.stat(sourceAbsPath)
  if (!stats.isFile()) {
    throw new Error('Dropbox upload source must be a file')
  }

  const apiPath = dropboxRelPath ? dropboxRelPathToApiPath(dropboxRelPath) : toDropboxApiPath(rawPath)
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1)
  console.log(`[DROPBOX] Starting upload with progress (${sizeMB} MB) → ${apiPath}`)

  if (stats.size <= DROPBOX_SIMPLE_UPLOAD_LIMIT_BYTES) {
    await uploadSmallFileToDropbox(sourceAbsPath, apiPath)
    onProgress?.(stats.size, stats.size)
    return
  }

  await uploadLargeFileToDropboxWithProgress(sourceAbsPath, apiPath, onProgress)
}