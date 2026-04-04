import * as fs from 'fs'
import * as path from 'path'
import { prisma } from '@/lib/db'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import {
  getFilePath,
  getRawStoragePath,
  PROJECT_REDIRECT_FILENAME,
  PROJECT_REDIRECTS_INDEX_FILENAME,
  STORAGE_ROOT,
} from '@/lib/storage'
import { isDropboxStoragePath, stripDropboxStoragePrefix } from '@/lib/storage-provider-dropbox'

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export type ProjectStorageOrphanCleanupResult = {
  ok: true
  dryRun: boolean
  scannedDirectories: number
  scannedProjects: number
  scannedFiles: number
  orphanFiles: number
  orphanFileBytes: number
  sample?: {
    orphanPaths: string[]
    projectIds: string[]
  }
  deleted?: {
    filesDeleted: number
    filesFailed: number
    emptyDirsPruned: number
  }
  errors?: Array<{ path: string; error: string }>
}

type ProjectStorageReferences = {
  exactFilePaths: Set<string>
  protectedDirectoryPrefixes: Set<string>
}

type ProjectRootIndex = Map<string, string>

type OrphanFileEntry = {
  absPath: string
  relPath: string
  bytes: number
}

function toStorageRelative(absPath: string): string {
  return path.relative(STORAGE_ROOT, absPath).replace(/\\/g, '/')
}

function normalizeRelativeStoragePath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function isProtectedMetadataFile(relPath: string): boolean {
  const normalized = normalizeRelativeStoragePath(relPath)
  return (
    normalized === `projects/${PROJECT_REDIRECTS_INDEX_FILENAME}` ||
    path.posix.basename(normalized) === PROJECT_REDIRECT_FILENAME
  )
}

function isIgnoredStoragePath(relPath: string): boolean {
  const normalized = normalizeRelativeStoragePath(relPath)
  return (
    normalized === '.tus-tmp'
    || normalized.startsWith('.tus-tmp/')
    || isProtectedMetadataFile(normalized)
  )
}

function extractProjectId(relPath: string): string | null {
  const parts = normalizeRelativeStoragePath(relPath).split('/').filter(Boolean)
  if (parts[0] !== 'projects') return null
  if (parts[1] === 'closed') return null
  if (YEAR_MONTH_RE.test(parts[1] || '')) return parts[2] || null
  return parts[1] || null
}

function shouldPruneEmptyDir(relPath: string): boolean {
  const parts = normalizeRelativeStoragePath(relPath).split('/').filter(Boolean)
  if (parts.length === 0) return false

  if (parts[0] === 'branding') {
    return parts.length > 1
  }

  if (parts[0] === 'users') {
    return parts.length > 2
  }

  if (parts[0] === 'clients') {
    if (parts[2] === 'files') return parts.length > 3
    return parts[2] === 'projects' && parts.length > 4
  }

  if (parts[0] !== 'projects') return false
  if (parts[1] === 'closed') return false

  if (YEAR_MONTH_RE.test(parts[1] || '')) {
    return parts.length > 3
  }

  return parts.length > 2
}

async function buildProjectRootIndex(): Promise<ProjectRootIndex> {
  const index: ProjectRootIndex = new Map()

  const projects = await prisma.project.findMany({
    select: {
      id: true,
      storagePath: true,
      title: true,
      companyName: true,
      client: { select: { name: true } },
    },
  })

  for (const project of projects) {
    const projectStoragePath = project.storagePath
      || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)

    index.set(normalizeRelativeStoragePath(projectStoragePath), project.id)
  }

  return index
}

function lookupProjectIdForPath(relPath: string, projectRootIndex: ProjectRootIndex): string | null {
  const normalized = normalizeRelativeStoragePath(relPath)
  const legacyProjectId = extractProjectId(normalized)
  if (legacyProjectId) return legacyProjectId

  let bestMatch: string | null = null
  for (const projectRoot of projectRootIndex.keys()) {
    if (normalized === projectRoot || normalized.startsWith(`${projectRoot}/`)) {
      if (!bestMatch || projectRoot.length > bestMatch.length) {
        bestMatch = projectRoot
      }
    }
  }

  return bestMatch ? projectRootIndex.get(bestMatch) || null : null
}

function isReferencedPath(relPath: string, refs: ProjectStorageReferences): boolean {
  const normalized = normalizeRelativeStoragePath(relPath)
  if (refs.exactFilePaths.has(normalized)) return true

  for (const prefix of refs.protectedDirectoryPrefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true
    }
  }

  return false
}

function normalizeStoredReferencePath(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null

  const trimmed = storagePath.trim()
  if (!trimmed) return null

  return isDropboxStoragePath(trimmed)
    ? stripDropboxStoragePrefix(trimmed)
    : trimmed
}

function addResolvedFilePath(target: Set<string>, storagePath: string | null | undefined) {
  const normalizedStoragePath = normalizeStoredReferencePath(storagePath)
  if (!normalizedStoragePath) return
  try {
    target.add(normalizeRelativeStoragePath(toStorageRelative(getFilePath(normalizedStoragePath))))
  } catch {
    // Ignore malformed historical paths; the cleanup only acts on proven orphans.
  }
}

function addResolvedDirectoryPrefix(target: Set<string>, storagePath: string | null | undefined) {
  const normalizedStoragePath = normalizeStoredReferencePath(storagePath)
  if (!normalizedStoragePath) return
  try {
    target.add(normalizeRelativeStoragePath(toStorageRelative(getFilePath(normalizedStoragePath))))
  } catch {
    // Ignore malformed historical paths; the cleanup only acts on proven orphans.
  }
}

async function buildProjectStorageReferences(): Promise<ProjectStorageReferences> {
  const exactFilePaths = new Set<string>()
  const protectedDirectoryPrefixes = new Set<string>()

  const [videos, videoAssets, commentFiles, projectFiles, albumPhotos, projectEmails, projectEmailAttachments, albums, clientFiles, userFiles, users, settings] = await Promise.all([
    prisma.video.findMany({
      select: {
        projectId: true,
        originalStoragePath: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        thumbnailPath: true,
        timelinePreviewVttPath: true,
        timelinePreviewSpritesPath: true,
      },
    }),
    prisma.videoAsset.findMany({ select: { storagePath: true } }),
    prisma.commentFile.findMany({ select: { storagePath: true } }),
    prisma.projectFile.findMany({ select: { storagePath: true } }),
    prisma.albumPhoto.findMany({ select: { storagePath: true, socialStoragePath: true } }),
    prisma.projectEmail.findMany({ select: { rawStoragePath: true } }),
    prisma.projectEmailAttachment.findMany({ select: { storagePath: true } }),
    prisma.album.findMany({
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
        project: {
          select: {
            storagePath: true,
            title: true,
            companyName: true,
            client: { select: { name: true } },
          },
        },
      },
    }),
    prisma.clientFile.findMany({ select: { storagePath: true } }),
    prisma.userFile.findMany({ select: { storagePath: true } }),
    prisma.user.findMany({ select: { avatarPath: true } }),
    prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        companyLogoPath: true,
        darkLogoPath: true,
        companyFaviconPath: true,
      },
    }),
  ])

  for (const video of videos) {
    addResolvedFilePath(exactFilePaths, video.originalStoragePath)
    addResolvedFilePath(exactFilePaths, video.preview480Path)
    addResolvedFilePath(exactFilePaths, video.preview720Path)
    addResolvedFilePath(exactFilePaths, video.preview1080Path)
    addResolvedFilePath(exactFilePaths, video.thumbnailPath)
    addResolvedFilePath(exactFilePaths, video.timelinePreviewVttPath)
    addResolvedDirectoryPrefix(protectedDirectoryPrefixes, video.timelinePreviewSpritesPath)
  }

  for (const videoAsset of videoAssets) addResolvedFilePath(exactFilePaths, videoAsset.storagePath)
  for (const commentFile of commentFiles) addResolvedFilePath(exactFilePaths, commentFile.storagePath)
  for (const projectFile of projectFiles) addResolvedFilePath(exactFilePaths, projectFile.storagePath)

  for (const albumPhoto of albumPhotos) {
    addResolvedFilePath(exactFilePaths, albumPhoto.storagePath)
    addResolvedFilePath(exactFilePaths, albumPhoto.socialStoragePath)
  }

  for (const projectEmail of projectEmails) addResolvedFilePath(exactFilePaths, projectEmail.rawStoragePath)
  for (const attachment of projectEmailAttachments) addResolvedFilePath(exactFilePaths, attachment.storagePath)
  for (const clientFile of clientFiles) addResolvedFilePath(exactFilePaths, clientFile.storagePath)
  for (const userFile of userFiles) addResolvedFilePath(exactFilePaths, userFile.storagePath)
  for (const user of users) addResolvedFilePath(exactFilePaths, user.avatarPath)

  addResolvedFilePath(exactFilePaths, settings?.companyLogoPath)
  addResolvedFilePath(exactFilePaths, settings?.darkLogoPath)
  addResolvedFilePath(exactFilePaths, settings?.companyFaviconPath)

  for (const album of albums) {
    const projectStoragePath = album.project.storagePath
      || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
    const albumFolderName = album.storageFolderName || album.name
    addResolvedFilePath(
      exactFilePaths,
      getAlbumZipStoragePath({ projectStoragePath, albumFolderName, albumName: album.name, variant: 'full' })
    )
    addResolvedFilePath(
      exactFilePaths,
      getAlbumZipStoragePath({ projectStoragePath, albumFolderName, albumName: album.name, variant: 'social' })
    )
  }

  return { exactFilePaths, protectedDirectoryPrefixes }
}

async function listPhysicalProjectRoots(): Promise<Array<{ absPath: string; relPath: string }>> {
  const roots: Array<{ absPath: string; relPath: string }> = []

  const entries = await fs.promises.readdir(STORAGE_ROOT, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const relPath = normalizeRelativeStoragePath(entry.name)
    if (isIgnoredStoragePath(relPath)) continue

    roots.push({
      absPath: path.join(STORAGE_ROOT, entry.name),
      relPath,
    })
  }

  return roots
}

async function walkProjectFiles(
  dirAbs: string,
  dirRel: string,
  out: OrphanFileEntry[],
  refs: ProjectStorageReferences,
  errors: Array<{ path: string; error: string }>,
  stats: { scannedFiles: number }
): Promise<void> {
  const entries = await fs.promises.readdir(dirAbs, { withFileTypes: true }).catch((error: any) => {
    errors.push({ path: dirRel, error: String(error?.message || error) })
    return [] as fs.Dirent[]
  })

  for (const entry of entries) {
    const entryAbs = path.join(dirAbs, entry.name)
    const entryRel = normalizeRelativeStoragePath(`${dirRel}/${entry.name}`)

    if (isIgnoredStoragePath(entryRel)) continue

    if (entry.isDirectory()) {
      await walkProjectFiles(entryAbs, entryRel, out, refs, errors, stats)
      continue
    }

    if (isProtectedMetadataFile(entryRel)) continue

    try {
      const fileStat = await fs.promises.stat(entryAbs)
      if (!fileStat.isFile()) continue

      stats.scannedFiles++
      if (!isReferencedPath(entryRel, refs)) {
        out.push({
          absPath: entryAbs,
          relPath: normalizeRelativeStoragePath(entryRel),
          bytes: fileStat.size,
        })
      }
    } catch (error: any) {
      errors.push({ path: entryRel, error: String(error?.message || error) })
    }
  }
}

function buildDirPruneCandidates(orphanFiles: OrphanFileEntry[]): string[] {
  const candidates = new Set<string>()

  for (const orphanFile of orphanFiles) {
    let current = path.posix.dirname(orphanFile.relPath)
    while (current && current !== '.' && shouldPruneEmptyDir(current)) {
      candidates.add(current)
      current = path.posix.dirname(current)
    }
  }

  return Array.from(candidates).sort((left, right) => right.split('/').length - left.split('/').length)
}

async function pruneEmptyDirectories(dirRels: string[], dryRun: boolean): Promise<number> {
  let emptyDirsPruned = 0

  for (const dirRel of dirRels) {
    const dirAbs = getRawStoragePath(dirRel)
    if (!fs.existsSync(dirAbs)) continue

    const stat = await fs.promises.stat(dirAbs).catch(() => null)
    if (!stat?.isDirectory()) continue

    const children = await fs.promises.readdir(dirAbs).catch(() => null)
    if (!children || children.length > 0) continue

    emptyDirsPruned++
    if (!dryRun) {
      await fs.promises.rm(dirAbs, { recursive: true, force: true })
    }
  }

  return emptyDirsPruned
}

export async function cleanupProjectStorageOrphans(dryRun: boolean): Promise<ProjectStorageOrphanCleanupResult> {
  const [refs, roots, projectRootIndex] = await Promise.all([
    buildProjectStorageReferences(),
    listPhysicalProjectRoots(),
    buildProjectRootIndex(),
  ])
  const errors: Array<{ path: string; error: string }> = []
  const orphanFiles: OrphanFileEntry[] = []
  const stats = { scannedFiles: 0 }

  for (const root of roots) {
    await walkProjectFiles(root.absPath, root.relPath, orphanFiles, refs, errors, stats)
  }

  const orphanFileBytes = orphanFiles.reduce((total, file) => total + file.bytes, 0)
  const sampleProjectIds = Array.from(
    new Set(
      orphanFiles
        .map((file) => lookupProjectIdForPath(file.relPath, projectRootIndex))
        .filter((projectId): projectId is string => Boolean(projectId))
    )
  ).slice(0, 20)

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      scannedDirectories: roots.length,
      scannedProjects: projectRootIndex.size,
      scannedFiles: stats.scannedFiles,
      orphanFiles: orphanFiles.length,
      orphanFileBytes,
      sample: {
        orphanPaths: orphanFiles.slice(0, 20).map((file) => file.relPath),
        projectIds: sampleProjectIds,
      },
      errors: errors.length ? errors.slice(0, 50) : undefined,
    }
  }

  let filesDeleted = 0
  let filesFailed = 0
  for (const orphanFile of orphanFiles) {
    try {
      await fs.promises.unlink(orphanFile.absPath)
      filesDeleted++
    } catch (error: any) {
      filesFailed++
      errors.push({ path: orphanFile.relPath, error: String(error?.message || error) })
    }
  }

  const emptyDirsPruned = await pruneEmptyDirectories(buildDirPruneCandidates(orphanFiles), false)

  return {
    ok: true,
    dryRun: false,
    scannedDirectories: roots.length,
    scannedProjects: projectRootIndex.size,
    scannedFiles: stats.scannedFiles,
    orphanFiles: orphanFiles.length,
    orphanFileBytes,
    sample: {
      orphanPaths: orphanFiles.slice(0, 20).map((file) => file.relPath),
      projectIds: sampleProjectIds,
    },
    deleted: {
      filesDeleted,
      filesFailed,
      emptyDirsPruned,
    },
    errors: errors.length ? errors.slice(0, 50) : undefined,
  }
}