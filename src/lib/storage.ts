import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { mkdir } from 'fs/promises'
import { deleteDropboxFile, isDropboxStoragePath, stripDropboxStoragePrefix } from '@/lib/storage-provider-dropbox'

export const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')

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
const projectLayoutEnsureCache = new Map<string, Promise<void>>()

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

function validatePathForWrite(filePath: string): string {
  const { fullPath, posixNormalized } = validatePathBase(filePath)
  const redirected = resolveRedirectedProjectPath(posixNormalized, fullPath, { forWrite: true })
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

function toYearMonthUTC(dateLike: Date): string {
  const yyyy = dateLike.getUTCFullYear()
  const mm = String(dateLike.getUTCMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}`
}

function findYearMonthProjectPathPosix(projectId: string): string | null {
  try {
    const projectsRootAbs = path.join(STORAGE_ROOT, 'projects')
    if (!fs.existsSync(projectsRootAbs)) return null

    const matches = fs.readdirSync(projectsRootAbs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidYearMonth(entry.name))
      .map((entry) => entry.name)
      .filter((ym) => {
        const candidateAbs = path.join(projectsRootAbs, ym, projectId)
        return fs.existsSync(candidateAbs) && fs.statSync(candidateAbs).isDirectory()
      })
      .sort()

    if (matches.length === 0) return null
    return `projects/${matches[0]}/${projectId}`
  } catch {
    return null
  }
}

export async function ensureProjectStorageLayout(
  projectId: string,
  opts?: { createdAt?: Date | string | null }
): Promise<void> {
  const pid = String(projectId || '').trim()
  if (!pid || pid === 'closed' || pid.startsWith('.')) return

  const cached = projectLayoutEnsureCache.get(pid)
  if (cached) {
    await cached
    return
  }

  const pending = (async () => {
    const existingTarget =
      readProjectRedirectTargetFromIndexPosix(pid) ||
      readProjectRedirectTargetPosix(pid) ||
      findYearMonthProjectPathPosix(pid)

    if (existingTarget) {
      await fs.promises.mkdir(path.join(STORAGE_ROOT, existingTarget), { recursive: true })
      await setProjectRedirect(pid, existingTarget).catch(() => {})
      return
    }

    try {
      let createdAt: Date | null = null
      if (opts?.createdAt) {
        const candidate = opts.createdAt instanceof Date ? opts.createdAt : new Date(opts.createdAt)
        if (!Number.isNaN(candidate.getTime())) {
          createdAt = candidate
        }
      }

      if (!createdAt) {
        const { prisma } = await import('@/lib/db')
        const project = await prisma.project.findUnique({
          where: { id: pid },
          select: { createdAt: true },
        })
        createdAt = project?.createdAt ?? null
      }

      if (!createdAt) return

      const targetRel = `projects/${toYearMonthUTC(createdAt)}/${pid}`
      await fs.promises.mkdir(path.join(STORAGE_ROOT, targetRel), { recursive: true })
      await setProjectRedirect(pid, targetRel).catch(() => {})
    } catch {
      // Best-effort bootstrap only. Legacy paths continue to work if this fails.
    }
  })()

  projectLayoutEnsureCache.set(pid, pending)
  try {
    await pending
  } finally {
    if (projectLayoutEnsureCache.get(pid) === pending) {
      projectLayoutEnsureCache.delete(pid)
    }
  }
}

async function ensureProjectStorageLayoutForPath(filePath: string): Promise<void> {
  const { posixNormalized } = validatePathBase(filePath)
  const info = isLegacyProjectPath(posixNormalized)
  if (!info) return

  await ensureProjectStorageLayout(info.projectId)
}

function resolveRedirectedProjectPath(
  posixNormalized: string,
  baseFullPath: string,
  opts?: { forWrite?: boolean }
): string | null {
  const info = isLegacyProjectPath(posixNormalized)
  if (!info) return null

  // Prefer the central redirect index. Fall back to legacy per-project stub file.
  const targetPosix =
    readProjectRedirectTargetFromIndexPosix(info.projectId) ||
    readProjectRedirectTargetPosix(info.projectId) ||
    findYearMonthProjectPathPosix(info.projectId)
  if (!targetPosix) return null

  const redirectedPosix = info.remainder ? path.posix.join(targetPosix, info.remainder) : targetPosix

  const redirectedAbs = path.join(STORAGE_ROOT, redirectedPosix)
  const realRedirected = path.resolve(redirectedAbs)
  const realRoot = path.resolve(STORAGE_ROOT)
  if (!realRedirected.startsWith(realRoot + path.sep) && realRedirected !== realRoot) {
    return null
  }

  if (opts?.forWrite) {
    return redirectedAbs
  }

  // Prefer the canonical YYYY-MM target when it already contains the requested file.
  if (redirectedAbs !== baseFullPath && fs.existsSync(redirectedAbs)) {
    return redirectedAbs
  }

  // For legacy projects that have not been migrated yet, keep reading the legacy-root child
  // if that is the only copy that exists.
  const isProjectRoot = posixNormalized === `projects/${info.projectId}`
  if (!isProjectRoot && fs.existsSync(baseFullPath)) return null

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
  await ensureProjectStorageLayoutForPath(filePath)
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
  if (isDropboxStoragePath(destLogicalPath)) {
    // For Dropbox-destined files, store locally first (fast same-filesystem rename).
    // The Dropbox upload is handled asynchronously by the dropbox-upload worker queue.
    const localPath = stripDropboxStoragePrefix(destLogicalPath)
    console.log(`[STORAGE] Dropbox path detected — storing locally at: ${localPath}`)

    await ensureProjectStorageLayoutForPath(localPath)
    const destFullPath = validatePathForWrite(localPath)
    const destDir = path.dirname(destFullPath)

    await mkdir(STORAGE_ROOT, { recursive: true })
    await mkdir(destDir, { recursive: true })

    try {
      await fs.promises.rename(srcAbsPath, destFullPath)
    } catch (err: any) {
      if (err?.code === 'EXDEV') {
        const readStream = fs.createReadStream(srcAbsPath)
        const writeStream = fs.createWriteStream(destFullPath)
        await pipeline(readStream, writeStream)
        await fs.promises.unlink(srcAbsPath).catch(() => {})
      } else {
        throw err
      }
    }

    const stats = await fs.promises.stat(destFullPath)
    if (stats.size !== expectedSize) {
      await fs.promises.unlink(destFullPath).catch(() => {})
      throw new Error(
        `File size mismatch after move: expected ${expectedSize} bytes, got ${stats.size} bytes.`
      )
    }

    await fs.promises.unlink(`${srcAbsPath}.json`).catch(() => {})
    return
  }

  await ensureProjectStorageLayoutForPath(destLogicalPath)
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
  // For Dropbox-stored files, resolve to the local copy (local-first model keeps files on disk)
  const resolvedPath = isDropboxStoragePath(filePath)
    ? stripDropboxStoragePrefix(filePath)
    : filePath
  const fullPath = validatePath(resolvedPath)
  return fs.createReadStream(fullPath)
}

export async function deleteFile(filePath: string): Promise<void> {
  if (isDropboxStoragePath(filePath)) {
    await deleteDropboxFile(filePath)
    return
  }

  const base = validatePathBase(filePath)
  const redirected = resolveRedirectedProjectPath(base.posixNormalized, base.fullPath, { forWrite: true })
  const candidates = redirected && redirected !== base.fullPath
    ? [redirected, base.fullPath]
    : [validatePath(filePath)]

  for (const fullPath of candidates) {
    if (!fs.existsSync(fullPath)) continue

    const stats = await fs.promises.stat(fullPath)
    if (stats.isFile()) {
      await fs.promises.unlink(fullPath)
    }
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
