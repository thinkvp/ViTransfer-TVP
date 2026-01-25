import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { mkdir } from 'fs/promises'

const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')

// Legacy project-path redirect support:
// Storage paths in DB are often under projects/{projectId}/...
// Physical storage lives under projects/YYYY-MM/{projectId}/...
// We resolve legacy paths via a central redirect index file under projects/.
//
// Back-compat: older versions used per-project stub folders at projects/{projectId}
// containing a .vitransfer_project_redirect file; we still *read* that if present.
export const PROJECT_REDIRECT_FILENAME = '.vitransfer_project_redirect'

export const PROJECT_REDIRECTS_INDEX_FILENAME = '.vitransfer_projects_redirects.json'

type ProjectRedirectIndex = Record<string, string>

let redirectIndexCache: ProjectRedirectIndex | null = null
let redirectIndexCacheMtimeMs: number | null = null

/**
 * Validate and sanitize file paths to prevent path traversal attacks
 * Defense-in-depth validation against multiple attack vectors
 *
 * @param filePath - The file path to validate
 * @returns Validated absolute path within storage root
 * @throws Error if path traversal is detected
 */
function validatePath(filePath: string): string {
  const { fullPath, posixNormalized } = validatePathBase(filePath)

  // Project redirect support:
  // If the requested path is under projects/{projectId}/... and it doesn't exist,
  // resolve via the per-project redirect file (projects/{projectId}/.vitransfer_project_redirect).
  const redirected = resolveRedirectedProjectPath(posixNormalized, fullPath)
  if (redirected) return redirected

  return fullPath
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

function isLegacyProjectPath(posixNormalized: string): { projectId: string; remainder: string } | null {
  // Legacy logical path form: projects/{projectId}/... or projects/{projectId}
  // (New physical layout may be projects/YYYY-MM/{projectId}/...)
  const parts = posixNormalized.split('/').filter(Boolean)
  if (parts.length < 2) return null
  if (parts[0] !== 'projects') return null
  // Do not treat YYYY-MM folders as project ids.
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(parts[1])) return null
  const projectId = parts[1]
  const remainder = parts.slice(2).join('/')
  return { projectId, remainder }
}

function readProjectRedirectTargetPosix(projectId: string): string | null {
  const projectRootAbs = path.join(STORAGE_ROOT, 'projects', projectId)
  const redirectFileAbs = path.join(projectRootAbs, PROJECT_REDIRECT_FILENAME)

  try {
    if (!fs.existsSync(redirectFileAbs)) return null
    const stat = fs.statSync(redirectFileAbs)
    if (!stat.isFile()) return null

    const raw = fs.readFileSync(redirectFileAbs, 'utf8').trim()
    if (!raw) return null

    // Validate the redirect target is a relative POSIX path within storage root.
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
      decoded = decodeURIComponent(decoded)
    } catch {
      decoded = raw
    }

    decoded = decoded.replace(/\\/g, '/')
    if (decoded.startsWith('/') || decoded.startsWith('\\')) {
      throw new Error('Invalid redirect target - absolute path not allowed')
    }
    if (/^[a-zA-Z]:/.test(decoded) || decoded.includes(':')) {
      throw new Error('Invalid redirect target - invalid characters')
    }

    const normalized = path.posix.normalize(decoded)
    if (
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.includes('/../')
    ) {
      throw new Error('Invalid redirect target - path traversal detected')
    }

    return normalized
  } catch (e) {
    // Fail closed: if redirect file exists but is invalid, do not follow it.
    return null
  }
}

function getRedirectIndexAbs(): string {
  return path.join(STORAGE_ROOT, 'projects', PROJECT_REDIRECTS_INDEX_FILENAME)
}

function validateRedirectTargetPosix(raw: string): string | null {
  let decoded = String(raw || '').trim()
  if (!decoded) return null

  try {
    decoded = decodeURIComponent(decoded)
    decoded = decodeURIComponent(decoded)
  } catch {
    // keep raw
  }

  decoded = decoded.replace(/\\/g, '/')
  if (decoded.startsWith('/') || decoded.startsWith('\\')) return null
  if (/^[a-zA-Z]:/.test(decoded) || decoded.includes(':')) return null

  const normalized = path.posix.normalize(decoded)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null
  }

  return normalized
}

function readProjectRedirectTargetFromIndexPosix(projectId: string): string | null {
  try {
    const indexAbs = getRedirectIndexAbs()
    if (!fs.existsSync(indexAbs)) {
      if (redirectIndexCache == null || redirectIndexCacheMtimeMs !== -1) {
        redirectIndexCache = {}
        redirectIndexCacheMtimeMs = -1
      }
      return null
    }

    const st = fs.statSync(indexAbs)
    if (!st.isFile()) return null

    if (redirectIndexCache && redirectIndexCacheMtimeMs === st.mtimeMs) {
      const target = redirectIndexCache[projectId]
      return target ? validateRedirectTargetPosix(target) : null
    }

    const raw = fs.readFileSync(indexAbs, 'utf8')
    const parsed = JSON.parse(raw || '{}') as unknown
    const map: ProjectRedirectIndex =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as ProjectRedirectIndex)
        : {}

    redirectIndexCache = map
    redirectIndexCacheMtimeMs = st.mtimeMs

    const target = map[projectId]
    return target ? validateRedirectTargetPosix(target) : null
  } catch {
    return null
  }
}

async function writeRedirectIndex(nextIndex: ProjectRedirectIndex): Promise<void> {
  const indexAbs = getRedirectIndexAbs()
  const dirAbs = path.dirname(indexAbs)
  await fs.promises.mkdir(dirAbs, { recursive: true })

  const tmpAbs = `${indexAbs}.tmp-${process.pid}-${Date.now()}`
  await fs.promises.writeFile(tmpAbs, JSON.stringify(nextIndex, null, 2), 'utf8')

  try {
    await fs.promises.rename(tmpAbs, indexAbs)
  } catch (e: any) {
    // Windows can't rename over existing; retry by removing then renaming.
    const code = String(e?.code || '')
    if (code === 'EEXIST' || code === 'EPERM') {
      await fs.promises.rm(indexAbs, { force: true })
      await fs.promises.rename(tmpAbs, indexAbs)
    } else {
      try {
        await fs.promises.rm(tmpAbs, { force: true })
      } catch {
        // ignore
      }
      throw e
    }
  }

  // Refresh cache (avoid a re-read per validatePath call).
  try {
    const st = await fs.promises.stat(indexAbs)
    redirectIndexCache = nextIndex
    redirectIndexCacheMtimeMs = st.mtimeMs
  } catch {
    redirectIndexCache = nextIndex
    redirectIndexCacheMtimeMs = null
  }
}

export async function setProjectRedirect(
  projectId: string,
  targetRel: string,
  opts?: { dryRun?: boolean }
): Promise<boolean> {
  const pid = String(projectId || '').trim()
  if (!pid) return false

  const normalized = validateRedirectTargetPosix(targetRel)
  if (!normalized) return false

  // Keep the mapping tightly scoped to the YYYY-MM physical layout.
  const expectedPrefix = `projects/`
  if (!normalized.startsWith(expectedPrefix)) return false
  if (!normalized.endsWith(`/${pid}`) && normalized !== `projects/${pid}`) {
    // The physical layout should end with /{projectId}; be strict.
    return false
  }

  const dryRun = opts?.dryRun === true

  // Ensure cache is at least initialized.
  readProjectRedirectTargetFromIndexPosix(pid)
  const live = redirectIndexCache ?? {}

  if (live[pid] === normalized) return false

  const next: ProjectRedirectIndex = { ...live, [pid]: normalized }
  if (!dryRun) {
    await writeRedirectIndex(next)
  }

  return true
}

export async function removeProjectRedirect(
  projectId: string,
  opts?: { dryRun?: boolean }
): Promise<boolean> {
  const pid = String(projectId || '').trim()
  if (!pid) return false

  const dryRun = opts?.dryRun === true

  readProjectRedirectTargetFromIndexPosix(pid)
  const live = redirectIndexCache ?? {}
  if (!Object.prototype.hasOwnProperty.call(live, pid)) return false

  const next: ProjectRedirectIndex = { ...live }
  delete next[pid]
  if (!dryRun) {
    await writeRedirectIndex(next)
  }
  return true
}

function isValidYearMonth(v: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
}
function resolveRedirectedProjectPath(posixNormalized: string, baseFullPath: string): string | null {
  const info = isLegacyProjectPath(posixNormalized)
  if (!info) return null

  // If the caller requested a child path and it already exists in the active folder, do not redirect.
  const isProjectRoot = posixNormalized === `projects/${info.projectId}`
  if (!isProjectRoot && fs.existsSync(baseFullPath)) return null

  // Prefer the central redirect index. Fall back to legacy per-project stub file.
  const targetPosix =
    readProjectRedirectTargetFromIndexPosix(info.projectId) ||
    readProjectRedirectTargetPosix(info.projectId)
  if (!targetPosix) return null

  const redirectedPosix = info.remainder ? path.posix.join(targetPosix, info.remainder) : targetPosix

  const redirectedAbs = path.join(STORAGE_ROOT, redirectedPosix)
  const realRedirected = path.resolve(redirectedAbs)
  const realRoot = path.resolve(STORAGE_ROOT)
  if (!realRedirected.startsWith(realRoot + path.sep) && realRedirected !== realRoot) {
    return null
  }

  return redirectedAbs
}

export async function initStorage() {
  await mkdir(STORAGE_ROOT, { recursive: true })
}

export async function uploadFile(
  filePath: string,
  stream: Readable | Buffer,
  size: number,
  contentType: string = 'application/octet-stream'
): Promise<void> {
  const fullPath = validatePath(filePath)
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

export async function downloadFile(filePath: string): Promise<Readable> {
  const fullPath = validatePath(filePath)
  return fs.createReadStream(fullPath)
}

export async function deleteFile(filePath: string): Promise<void> {
  const fullPath = validatePath(filePath)
  if (fs.existsSync(fullPath)) {
    await fs.promises.unlink(fullPath)
  }
}

export async function deleteDirectory(dirPath: string): Promise<void> {
  const base = validatePathBase(dirPath)
  const redirected = resolveRedirectedProjectPath(base.posixNormalized, base.fullPath)
  const fullPath = redirected || base.fullPath

  if (fs.existsSync(fullPath)) {
    await fs.promises.rm(fullPath, { recursive: true, force: true })
  }

  // If the caller targeted the legacy stub folder, also remove it.
  const legacyInfo = isLegacyProjectPath(base.posixNormalized)
  if (legacyInfo && redirected && base.fullPath !== fullPath && fs.existsSync(base.fullPath)) {
    await fs.promises.rm(base.fullPath, { recursive: true, force: true })
  }
}

export function getFilePath(filePath: string): string {
  return validatePath(filePath)
}

// Returns the absolute path inside STORAGE_ROOT without applying project-archive redirects.
// Intended for internal server maintenance tasks (moves/redirect stub management).
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
