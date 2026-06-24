import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { mkdir } from 'fs/promises'
import { isS3Mode, s3UploadFile, s3DownloadFile, s3DeleteFile, s3DeleteDirectory, s3MoveDirectory, s3MoveFile } from '@/lib/s3-storage'

export const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')

/**
 * Validate and sanitize file paths to prevent path traversal attacks
 * Defense-in-depth validation against multiple attack vectors
 *
 * @param filePath - The file path to validate
 * @returns Validated absolute path within storage root
 * @throws Error if path traversal is detected
 */
function validatePath(filePath: string): string {
  return validatePathBase(filePath).fullPath
}

function validatePathForWrite(filePath: string): string {
  return validatePathBase(filePath).fullPath
}

function validatePathBase(filePath: string): { fullPath: string; posixNormalized: string } {
  // 1. Reject null bytes (common in path traversal exploits)
  if (filePath.includes('\0')) {
    throw new Error('Invalid file path - null byte detected')
  }

  // 2. URL decode to catch encoded path traversal attempts (%2e%2e%2f, etc.)
  let decoded = filePath
  try {
    decoded = decodeURIComponent(filePath)
    // Double-decode to catch double-encoding attacks
    decoded = decodeURIComponent(decoded)
  } catch (error) {
    // If decode fails, use original (might be already decoded)
    decoded = filePath
  }

  // 3. Normalize path separators (convert backslashes to forward slashes)
  decoded = decoded.replace(/\\/g, '/')

  // Storage paths are expected to be *relative* POSIX-style paths like:
  //   projects/{projectId}/videos/{videoId}/...
  // Treat anything absolute / drive-letter / UNC as invalid.
  if (decoded.startsWith('/') || decoded.startsWith('\\')) {
    throw new Error('Invalid file path - absolute path not allowed')
  }
  // Disallow drive letters / schemes (e.g. C:..., file:...)
  if (/^[a-zA-Z]:/.test(decoded) || decoded.includes(':')) {
    throw new Error('Invalid file path - invalid characters')
  }

  // 4. Normalize using POSIX rules, then reject any traversal segments
  const posixNormalized = path.posix.normalize(decoded)
  if (
    posixNormalized === '.' ||
    posixNormalized === '..' ||
    posixNormalized.startsWith('../') ||
    posixNormalized.includes('/../')
  ) {
    throw new Error('Invalid file path - path traversal detected')
  }

  // 5. Build the full path and resolve it
  const fullPath = path.join(STORAGE_ROOT, posixNormalized)
  const realPath = path.resolve(fullPath)
  const realRoot = path.resolve(STORAGE_ROOT)

  // 7. Final check: ensure resolved path is within storage root
  if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
    throw new Error('Invalid file path - path traversal detected')
  }

  return { fullPath, posixNormalized }
}

export async function initStorage() {
  if (isS3Mode()) {
    console.log('[STORAGE] S3 mode active — using Cloudflare R2 for file storage.')
    return
  }
  await mkdir(STORAGE_ROOT, { recursive: true })
}

export async function uploadFile(
  filePath: string,
  stream: Readable | Buffer,
  size: number,
  contentType: string = 'application/octet-stream'
): Promise<void> {
  if (isS3Mode()) {
    await s3UploadFile(filePath, stream as any, contentType, size)
    return
  }

  const fullPath = validatePathForWrite(filePath)
  const dir = path.dirname(fullPath)

  await mkdir(dir, { recursive: true })

  // Use pipeline for proper stream handling with backpressure and error propagation
  if (Buffer.isBuffer(stream)) {
    // For buffers, write directly
    await fs.promises.writeFile(fullPath, stream)
  } else {
    // For streams, use pipeline which properly handles:
    // - Backpressure between read and write streams
    // - Error propagation from both streams
    // - Cleanup on errors
    // - Waits for both streams to complete before resolving
    const writeStream = fs.createWriteStream(fullPath)
    await pipeline(stream, writeStream)
  }

  // Verify file was written with correct size
  const stats = await fs.promises.stat(fullPath)
  if (stats.size !== size) {
    // Clean up corrupted file
    await fs.promises.unlink(fullPath).catch(() => {})
    throw new Error(
      `File size mismatch: expected ${size} bytes, got ${stats.size} bytes. ` +
      `Upload may have been corrupted.`
    )
  }
}

/**
 * Move a file from an absolute source path (e.g. a TUS temp file) to a logical
 * storage path (relative to STORAGE_ROOT), using an atomic fs.rename when the
 * source and destination are on the same filesystem, or falling back to a
 * stream-copy + unlink when they are not (EXDEV cross-device).
 *
 * The TUS .json sidecar for the source is also removed on success.
 */
export async function moveUploadedFile(
  srcAbsPath: string,
  destLogicalPath: string,
  expectedSize: number,
): Promise<void> {
  // In S3 mode: stream the local temp file to R2 then delete the temp file.
  if (isS3Mode()) {
    const stat = await fs.promises.stat(srcAbsPath)
    if (stat.size !== expectedSize) {
      await fs.promises.unlink(srcAbsPath).catch(() => {})
      throw new Error(
        `File size mismatch before S3 upload: expected ${expectedSize} bytes, got ${stat.size} bytes.`
      )
    }
    const readStream = fs.createReadStream(srcAbsPath)
    await s3UploadFile(destLogicalPath, readStream, 'application/octet-stream', expectedSize)
    await fs.promises.unlink(srcAbsPath).catch(() => {})
    await fs.promises.unlink(`${srcAbsPath}.json`).catch(() => {})
    console.log(`[STORAGE] Uploaded TUS temp file to S3: ${destLogicalPath}`)
    return
  }

  const destFullPath = validatePathForWrite(destLogicalPath)
  const destDir = path.dirname(destFullPath)

  await mkdir(STORAGE_ROOT, { recursive: true })
  await mkdir(destDir, { recursive: true })

  try {
    // Fast path: atomic rename — zero cost when src and dest share a filesystem.
    // On Linux this is a single syscall (rename(2)) regardless of file size.
    await fs.promises.rename(srcAbsPath, destFullPath)
  } catch (err: any) {
    if (err?.code === 'EXDEV') {
      // Cross-device (different filesystem / mount point). Fall back to a streaming
      // copy then remove the original.
      const readStream = fs.createReadStream(srcAbsPath)
      const writeStream = fs.createWriteStream(destFullPath)
      await pipeline(readStream, writeStream)
      await fs.promises.unlink(srcAbsPath).catch(() => {})
    } else {
      throw err
    }
  }

  // Size sanity check — critical for the copy path; essentially free for rename.
  const stats = await fs.promises.stat(destFullPath)
  if (stats.size !== expectedSize) {
    await fs.promises.unlink(destFullPath).catch(() => {})
    throw new Error(
      `File size mismatch after move: expected ${expectedSize} bytes, got ${stats.size} bytes.`
    )
  }

  // Remove the TUS .json metadata sidecar (best-effort).
  await fs.promises.unlink(`${srcAbsPath}.json`).catch(() => {})
}

export async function downloadFile(filePath: string): Promise<Readable> {
  if (isS3Mode()) {
    const { stream } = await s3DownloadFile(filePath)
    return stream
  }
  const fullPath = validatePath(filePath)
  return fs.createReadStream(fullPath)
}

export async function deleteFile(filePath: string): Promise<void> {
  if (isS3Mode()) {
    await s3DeleteFile(filePath)
    return
  }

  const fullPath = validatePath(filePath)

  if (fs.existsSync(fullPath)) {
    const stats = await fs.promises.stat(fullPath)
    if (stats.isFile()) {
      await fs.promises.unlink(fullPath)
    }
  }
}

export async function deleteDirectory(dirPath: string): Promise<void> {
  if (isS3Mode()) {
    await s3DeleteDirectory(dirPath)
    return
  }

  const fullPath = validatePath(dirPath)

  if (fs.existsSync(fullPath)) {
    await fs.promises.rm(fullPath, { recursive: true, force: true })
  }
}

export async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  if (isS3Mode()) {
    await s3MoveFile(sourcePath, destinationPath)
    return
  }

  const sourceFullPath = getRawStoragePath(sourcePath)
  const destinationFullPath = getRawStoragePath(destinationPath)

  if (sourceFullPath === destinationFullPath) {
    return
  }

  if (!fs.existsSync(sourceFullPath)) {
    return
  }

  await fs.promises.mkdir(path.dirname(destinationFullPath), { recursive: true })

  try {
    await fs.promises.rename(sourceFullPath, destinationFullPath)
  } catch (error: any) {
    if (error?.code === 'EXDEV') {
      await fs.promises.copyFile(sourceFullPath, destinationFullPath)
      await fs.promises.unlink(sourceFullPath)
      return
    }

    if (error?.code === 'EEXIST') {
      return
    }

    throw error
  }
}

async function removeDirectoryIfEmpty(fullPath: string): Promise<boolean> {
  if (!fs.existsSync(fullPath)) {
    return false
  }

  const stats = await fs.promises.stat(fullPath).catch(() => null)
  if (!stats?.isDirectory()) {
    return false
  }

  const children = await fs.promises.readdir(fullPath).catch(() => null)
  if (!children || children.length > 0) {
    return false
  }

  await fs.promises.rmdir(fullPath).catch(() => {})
  return !fs.existsSync(fullPath)
}

export async function pruneEmptyParentDirectories(dirPath: string, stopAt?: string): Promise<number> {
  const stopAtNormalized = stopAt ? validatePathBase(stopAt).posixNormalized : null
  let current = validatePathBase(dirPath).posixNormalized
  let pruned = 0

  while (current && current !== '.' && current !== stopAtNormalized) {
    const base = validatePathBase(current)

    if (!await removeDirectoryIfEmpty(base.fullPath)) {
      break
    }

    pruned += 1
    const parent = path.posix.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return pruned
}

async function moveDirectoryContents(fromFullPath: string, toFullPath: string): Promise<void> {
  await fs.promises.mkdir(toFullPath, { recursive: true })

  const entries = await fs.promises.readdir(fromFullPath, { withFileTypes: true })
  for (const entry of entries) {
    const sourceChild = path.join(fromFullPath, entry.name)
    const targetChild = path.join(toFullPath, entry.name)

    if (fs.existsSync(targetChild)) {
      const targetStats = await fs.promises.lstat(targetChild)
      if (entry.isDirectory() && targetStats.isDirectory()) {
        await moveDirectoryContents(sourceChild, targetChild)
        continue
      }

      throw new Error(`Destination already exists: ${targetChild}`)
    }

    await fs.promises.rename(sourceChild, targetChild)
  }

  await fs.promises.rm(fromFullPath, { recursive: true, force: true })
}

export async function moveDirectory(
  fromDirPath: string,
  toDirPath: string,
  options?: { merge?: boolean },
): Promise<void> {
  if (isS3Mode()) {
    await s3MoveDirectory(fromDirPath, toDirPath, options)
    return
  }

  const fromFullPath = getRawStoragePath(fromDirPath)
  const toFullPath = getRawStoragePath(toDirPath)

  if (fromFullPath === toFullPath) {
    return
  }

  if (!fs.existsSync(fromFullPath)) {
    return
  }

  if (fs.existsSync(toFullPath)) {
    if (options?.merge) {
      await moveDirectoryContents(fromFullPath, toFullPath)
      return
    }

    throw new Error(`Destination already exists: ${toDirPath}`)
  }

  await fs.promises.mkdir(path.dirname(toFullPath), { recursive: true })

  try {
    await fs.promises.rename(fromFullPath, toFullPath)
  } catch (error: any) {
    if (error?.code === 'EXDEV') {
      await fs.promises.cp(fromFullPath, toFullPath, { recursive: true })
      await fs.promises.rm(fromFullPath, { recursive: true, force: true })
      return
    }

    throw error
  }
}

export function getFilePath(filePath: string): string {
  return validatePath(filePath)
}

// Returns the absolute path inside STORAGE_ROOT without validation redirects.
// Intended for internal server maintenance tasks (moves, path manipulation).
export function getRawStoragePath(filePath: string): string {
  return validatePathBase(filePath).fullPath
}

/**
 * Sanitize filename for Content-Disposition header
 * Prevents CRLF injection and other header injection attacks
 *
 * @param filename - The filename to sanitize
 * @returns Sanitized filename safe for HTTP headers
 */
export function sanitizeFilenameForHeader(filename: string): string {
  if (!filename) return 'download.mp4'

  return filename
    .replace(/["\\]/g, '')         // Remove quotes and backslashes
    .replace(/[\r\n]/g, '')        // Remove CRLF (header injection)
    .replace(/[^\x20-\x7E]/g, '_') // Replace non-ASCII with underscore
    .substring(0, 255)             // Limit length to 255 characters
    .trim() || 'download.mp4'      // Fallback if empty after sanitization
}
