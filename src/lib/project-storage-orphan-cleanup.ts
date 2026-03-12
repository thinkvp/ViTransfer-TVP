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

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export type ProjectStorageOrphanCleanupResult = {
  ok: true
  dryRun: boolean
  scannedProjectDirectories: number
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

function extractProjectId(relPath: string): string | null {
  const parts = normalizeRelativeStoragePath(relPath).split('/').filter(Boolean)
  if (parts[0] !== 'projects') return null
  if (parts[1] === 'closed') return null
  if (YEAR_MONTH_RE.test(parts[1] || '')) return parts[2] || null
  return parts[1] || null
}

function shouldPruneEmptyDir(relPath: string): boolean {
  const parts = normalizeRelativeStoragePath(relPath).split('/').filter(Boolean)
  if (parts[0] !== 'projects') return false
  if (parts[1] === 'closed') return false

  if (YEAR_MONTH_RE.test(parts[1] || '')) {
    return parts.length > 3
  }

  return parts.length > 2
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

function addResolvedFilePath(target: Set<string>, storagePath: string | null | undefined) {
  if (!storagePath) return
  try {
    target.add(normalizeRelativeStoragePath(toStorageRelative(getFilePath(storagePath))))
  } catch {
    // Ignore malformed historical paths; the cleanup only acts on proven orphans.
  }
}

function addResolvedDirectoryPrefix(target: Set<string>, storagePath: string | null | undefined) {
  if (!storagePath) return
  try {
    target.add(normalizeRelativeStoragePath(toStorageRelative(getFilePath(storagePath))))
  } catch {
    // Ignore malformed historical paths; the cleanup only acts on proven orphans.
  }
}

async function buildProjectStorageReferences(): Promise<ProjectStorageReferences> {
  const exactFilePaths = new Set<string>()
  const protectedDirectoryPrefixes = new Set<string>()

  const [videos, videoAssets, commentFiles, projectFiles, albumPhotos, projectEmails, projectEmailAttachments, albums] = await Promise.all([
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
  const projectsRootAbs = getRawStoragePath('projects')
  if (!fs.existsSync(projectsRootAbs)) return []

  const roots: Array<{ absPath: string; relPath: string }> = []
  const topLevelEntries = await fs.promises.readdir(projectsRootAbs, { withFileTypes: true }).catch(() => [])

  for (const entry of topLevelEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'closed') continue

    const entryAbs = path.join(projectsRootAbs, entry.name)
    const entryRel = `projects/${entry.name}`

    if (YEAR_MONTH_RE.test(entry.name)) {
      const projectDirs = await fs.promises.readdir(entryAbs, { withFileTypes: true }).catch(() => [])
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue
        roots.push({
          absPath: path.join(entryAbs, projectDir.name),
          relPath: `${entryRel}/${projectDir.name}`,
        })
      }
      continue
    }

    roots.push({ absPath: entryAbs, relPath: entryRel })
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
    const entryRel = `${dirRel}/${entry.name}`

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
  const refs = await buildProjectStorageReferences()
  const roots = await listPhysicalProjectRoots()
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
        .map((file) => extractProjectId(file.relPath))
        .filter((projectId): projectId is string => Boolean(projectId))
    )
  ).slice(0, 20)

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      scannedProjectDirectories: roots.length,
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
    scannedProjectDirectories: roots.length,
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