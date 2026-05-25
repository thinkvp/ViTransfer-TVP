import * as fs from 'fs'
import * as path from 'path'
import { prisma } from '@/lib/db'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot, buildVideoAssetPreviewStoragePath, buildVideoThumbnailStoragePath } from '@/lib/project-storage-paths'
import {
  getFilePath,
  getRawStoragePath,
  PROJECT_REDIRECT_FILENAME,
  PROJECT_REDIRECTS_INDEX_FILENAME,
  STORAGE_ROOT,
} from '@/lib/storage'
import { isDropboxStoragePath, stripDropboxStoragePrefix } from '@/lib/project-storage-paths'
import { isS3Mode, s3DeleteFile, getS3Bucket, getS3Client } from '@/lib/s3-storage'
import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import {
  ACCOUNTING_STORAGE_ROOT,
  ACCOUNTING_S3_PREFIX,
  listAccountingS3Keys,
  listAccountingLocalFiles,
} from '@/lib/accounting/file-storage'

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const UPLOAD_FOLDER_MARKER = '.vitransfer_folder'

type ShareUploadFilePathRow = { storagePath: string | null }
type ShareUploadFolderPathRow = { storagePath: string | null }
type ShareUploadPreviewPathRow = { storagePath: string | null; previewPath: string | null }
type VideoAssetPreviewPathRow = {
  storagePath: string | null
  previewPath: string | null
  fileType: string | null
  video: {
    storageFolderName: string | null
    name: string
    versionLabel: string
    project: {
      storagePath: string | null
      title: string
      companyName: string | null
      client: { name: string | null } | null
    }
  }
}

export type ProjectStorageOrphanCleanupResult = {
  ok: true
  dryRun: boolean
  scannedDirectories: number
  scannedProjects: number
  scannedFiles: number
  orphanFiles: number
  orphanFileBytes: number
  /** DB records whose file is absent from storage (file on storage ≠ file in DB) */
  missingFiles: number
  missingFileSample?: {
    paths: string[]
  }
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
    // Accounting files live under a separate prefix/volume and are scanned
    // independently by scanAccountingOrphans — exclude them here to prevent
    // the main S3 scan from treating all accounting files as orphans.
    || normalized === ACCOUNTING_S3_PREFIX
    || normalized.startsWith(`${ACCOUNTING_S3_PREFIX}/`)
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

function isTimelineSpriteFileName(fileName: string): boolean {
  return /^(?:sprite-\d{3}|timeline-\d+)\.jpg$/i.test(fileName)
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

  const [videos, videoAssets, commentFiles, shareUploadFiles, shareUploadFolders, projectFiles, albumPhotos, projectEmails, projectEmailAttachments, albums, clientFiles, userFiles, users, settings] = await Promise.all([
    prisma.video.findMany({
      select: {
        projectId: true,
        name: true,
        storageFolderName: true,
        versionLabel: true,
        originalStoragePath: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        thumbnailPath: true,
        timelinePreviewVttPath: true,
        timelinePreviewSpritesPath: true,
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
    prisma.videoAsset.findMany({
      select: {
        storagePath: true,
        previewPath: true,
        fileType: true,
        video: {
          select: {
            storageFolderName: true,
            name: true,
            versionLabel: true,
            project: {
              select: {
                storagePath: true,
                title: true,
                companyName: true,
                client: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    prisma.commentFile.findMany({ select: { storagePath: true } }),
    prisma.$queryRaw<ShareUploadPreviewPathRow[]>`SELECT "storagePath", "previewPath" FROM "ShareUploadFile"`,
    prisma.$queryRaw<ShareUploadFolderPathRow[]>`SELECT "storagePath" FROM "ShareUploadFolder"`,
    prisma.projectFile.findMany({ select: { storagePath: true } }),
    prisma.albumPhoto.findMany({ select: { storagePath: true, socialStoragePath: true, thumbnailStoragePath: true } }),
    prisma.projectEmail.findMany({ select: { rawStoragePath: true } }),
    prisma.projectEmailAttachment.findMany({ select: { storagePath: true } }),
    prisma.album.findMany({
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
        socialCopiesEnabled: true,
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

    // Also protect the canonical thumbnail path derived from project/video fields.
    // This mirrors the content API's buildCanonicalFallbackPath logic and prevents
    // false-positive orphan reports for videos where thumbnailPath is null or stale.
    const canonicalProjectStoragePath = video.project?.storagePath
      || buildProjectStorageRoot(
          video.project?.client?.name || video.project?.companyName || 'Client',
          video.project?.title || 'Untitled',
        )
    const canonicalVideoFolderName = video.storageFolderName || video.name
    if (canonicalVideoFolderName && video.versionLabel) {
      addResolvedFilePath(
        exactFilePaths,
        buildVideoThumbnailStoragePath(canonicalProjectStoragePath, canonicalVideoFolderName, video.versionLabel),
      )
    }

    // Third fallback: derive the thumbnail location directly from originalStoragePath's
    // parent directory. The original video file and thumbnail always reside in the same
    // version root folder, so this covers edge cases where thumbnailPath is null/stale
    // AND the storageFolderName-based canonical path doesn't match the physical folder
    // name on disk (e.g. due to Unicode path differences like en-dash vs hyphen, or a
    // partial rename where folder names diverged from DB fields).
    const rawOriginalPath = normalizeStoredReferencePath(video.originalStoragePath)
    if (rawOriginalPath) {
      try {
        const originalRelPath = normalizeRelativeStoragePath(toStorageRelative(getFilePath(rawOriginalPath)))
        const versionRoot = path.posix.dirname(originalRelPath)
        if (versionRoot && versionRoot !== '.') {
          exactFilePaths.add(path.posix.join(
            canonicalProjectStoragePath,
            '.previews',
            path.posix.relative(canonicalProjectStoragePath, versionRoot),
            'thumbnail.jpg',
          ))
        }
      } catch {
        // Ignore; the canonical check above will still cover this video's thumbnail
      }
    }
  }

  for (const videoAsset of videoAssets) {
    addResolvedFilePath(exactFilePaths, videoAsset.storagePath)
    addResolvedFilePath(exactFilePaths, videoAsset.previewPath)

    const previewPath = String(videoAsset.previewPath || '').toLowerCase()
    const fileType = String(videoAsset.fileType || '').toLowerCase()
    if (fileType.startsWith('video/') && previewPath.endsWith('.mp4')) {
      const projectStoragePath = videoAsset.video.project.storagePath
        || buildProjectStorageRoot(
          videoAsset.video.project.client?.name || videoAsset.video.project.companyName || 'Client',
          videoAsset.video.project.title,
        )
      addResolvedFilePath(
        exactFilePaths,
        buildVideoAssetPreviewStoragePath(
          projectStoragePath,
          videoAsset.video.storageFolderName || videoAsset.video.name,
          videoAsset.video.versionLabel,
          videoAsset.storagePath || '',
          '.jpg',
        ),
      )
    }
  }
  for (const commentFile of commentFiles) addResolvedFilePath(exactFilePaths, commentFile.storagePath)
  for (const shareUploadFile of shareUploadFiles) {
    addResolvedFilePath(exactFilePaths, shareUploadFile.storagePath)
    addResolvedFilePath(exactFilePaths, shareUploadFile.previewPath)
  }
  for (const shareUploadFolder of shareUploadFolders) {
    if (!shareUploadFolder.storagePath) continue
    addResolvedFilePath(exactFilePaths, `${shareUploadFolder.storagePath}/${UPLOAD_FOLDER_MARKER}`)
  }
  for (const projectFile of projectFiles) addResolvedFilePath(exactFilePaths, projectFile.storagePath)

  for (const albumPhoto of albumPhotos) {
    addResolvedFilePath(exactFilePaths, albumPhoto.storagePath)
    addResolvedFilePath(exactFilePaths, albumPhoto.socialStoragePath)
    addResolvedFilePath(exactFilePaths, albumPhoto.thumbnailStoragePath)
  }

  for (const projectEmail of projectEmails) addResolvedFilePath(exactFilePaths, projectEmail.rawStoragePath)
  for (const attachment of projectEmailAttachments) addResolvedFilePath(exactFilePaths, attachment.storagePath)
  for (const clientFile of clientFiles) addResolvedFilePath(exactFilePaths, clientFile.storagePath)
  for (const userFile of userFiles) addResolvedFilePath(exactFilePaths, userFile.storagePath)
  for (const user of users) addResolvedFilePath(exactFilePaths, user.avatarPath)

  addResolvedFilePath(exactFilePaths, settings?.companyLogoPath)
  addResolvedFilePath(exactFilePaths, settings?.companyFaviconPath)

  for (const album of albums) {
    const projectStoragePath = album.project.storagePath
      || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
    const albumFolderName = album.storageFolderName || album.name
    addResolvedFilePath(
      exactFilePaths,
      getAlbumZipStoragePath({ projectStoragePath, albumFolderName, albumName: album.name, variant: 'full' })
    )
    if (album.socialCopiesEnabled) {
      addResolvedFilePath(
        exactFilePaths,
        getAlbumZipStoragePath({ projectStoragePath, albumFolderName, albumName: album.name, variant: 'social' })
      )
    }
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

type S3ObjectEntry = {
  key: string
  bytes: number
}

/**
 * List all objects in the S3 bucket (no pagination limit — loads entire bucket).
 * Used for orphan detection when in S3 mode.
 */
async function listS3Objects(): Promise<S3ObjectEntry[]> {
  let objects: S3ObjectEntry[] = []

  try {
    const client = getS3Client()
    const bucket = getS3Bucket()
    let continuationToken: string | undefined

    do {
      const listResponse = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        })
      )

      for (const obj of listResponse.Contents ?? []) {
        if (obj.Key) {
          objects.push({
            key: obj.Key,
            bytes: obj.Size ?? 0,
          })
        }
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined
    } while (continuationToken)
  } catch (error: any) {
    // If S3 listing fails, return empty and let the scan continue on local filesystem
    console.warn('[orphan-cleanup] S3 listing failed:', error?.message || error)
  }

  return objects
}

/**
 * Scan S3 bucket for orphaned files (when in S3 mode).
 * Compares S3 object keys against database references to find unreferenced files.
 */
async function scanS3ForOrphans(
  s3Objects: S3ObjectEntry[],
  refs: ProjectStorageReferences,
  errors: Array<{ path: string; error: string }>,
  stats: { scannedFiles: number }
): Promise<OrphanFileEntry[]> {
  const orphanFiles: OrphanFileEntry[] = []

  for (const s3Object of s3Objects) {
    stats.scannedFiles++

    // Skip protected metadata files
    if (isProtectedMetadataFile(s3Object.key)) continue
    if (isIgnoredStoragePath(s3Object.key)) continue

    // Check if this S3 key is referenced in the database
    if (!isReferencedPath(s3Object.key, refs)) {
      orphanFiles.push({
        absPath: `s3://${getS3Bucket()}/${s3Object.key}`, // Mark as S3 path for reporting
        relPath: normalizeRelativeStoragePath(s3Object.key),
        bytes: s3Object.bytes,
      })
    }
  }

  return orphanFiles
}

/**
 * Build the set of directly-referenced file paths from the database for the
 * missing-files check.  Only includes fields that are always set when a record
 * is created (i.e. the primary uploaded file), NOT derived/computed paths such
 * as preview paths, thumbnail fallbacks, or ZIP archives that may not have been
 * generated yet.  Returns two sets:
 *   mainPaths       – paths relative to STORAGE_ROOT (= S3 keys in S3 mode)
 *   accountingPaths – paths relative to ACCOUNTING_STORAGE_ROOT (= storagePath DB field)
 */
async function buildMissingFilesReferences(): Promise<{ mainPaths: Set<string>; accountingPaths: Set<string>; timelineSpritePrefixes: Set<string> }> {
  const mainPaths = new Set<string>()
  const accountingPaths = new Set<string>()
  const timelineSpritePrefixes = new Set<string>()

  const [videos, videoAssets, commentFiles, shareUploadFiles, shareUploadFolders, projectFiles, albumPhotos, albums, projectEmails, projectEmailAttachments, clientFiles, userFiles, users, settings, accountingAttachments] = await Promise.all([
    prisma.video.findMany({
      select: {
        originalStoragePath: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        thumbnailPath: true,
        timelinePreviewVttPath: true,
        timelinePreviewSpritesPath: true,
      },
    }),
    prisma.videoAsset.findMany({
      select: {
        storagePath: true,
        previewPath: true,
        fileType: true,
        video: {
          select: {
            storageFolderName: true,
            name: true,
            versionLabel: true,
            project: {
              select: {
                storagePath: true,
                title: true,
                companyName: true,
                client: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    prisma.commentFile.findMany({ select: { storagePath: true } }),
    prisma.$queryRaw<ShareUploadPreviewPathRow[]>`SELECT "storagePath", "previewPath" FROM "ShareUploadFile"`,
    prisma.$queryRaw<ShareUploadFolderPathRow[]>`SELECT "storagePath" FROM "ShareUploadFolder"`,
    prisma.projectFile.findMany({ select: { storagePath: true } }),
    prisma.albumPhoto.findMany({ select: { storagePath: true, socialStoragePath: true, thumbnailStoragePath: true } }),
    prisma.album.findMany({
      select: {
        name: true,
        storageFolderName: true,
        socialCopiesEnabled: true,
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
    prisma.projectEmail.findMany({ select: { rawStoragePath: true } }),
    prisma.projectEmailAttachment.findMany({ select: { storagePath: true } }),
    prisma.clientFile.findMany({ select: { storagePath: true } }),
    prisma.userFile.findMany({ select: { storagePath: true } }),
    prisma.user.findMany({ select: { avatarPath: true } }),
    prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        companyLogoPath: true,
        companyFaviconPath: true,
      },
    }),
    prisma.accountingAttachment.findMany({ select: { storagePath: true } }),
  ])

  const addMain = (storagePath: string | null | undefined) => {
    const normalizedStoragePath = normalizeStoredReferencePath(storagePath)
    if (!normalizedStoragePath) return
    try {
      mainPaths.add(normalizeRelativeStoragePath(toStorageRelative(getFilePath(normalizedStoragePath))))
    } catch { /* malformed historical path */ }
  }

  const addTimelineSpritePrefix = (storagePath: string | null | undefined) => {
    const normalizedStoragePath = normalizeStoredReferencePath(storagePath)
    if (!normalizedStoragePath) return
    try {
      timelineSpritePrefixes.add(normalizeRelativeStoragePath(toStorageRelative(getFilePath(normalizedStoragePath))))
    } catch { /* malformed historical path */ }
  }

  for (const v of videos) {
    addMain(v.originalStoragePath)
    addMain(v.preview480Path)
    addMain(v.preview720Path)
    addMain(v.preview1080Path)
    addMain(v.thumbnailPath)
    addMain(v.timelinePreviewVttPath)
    addTimelineSpritePrefix(v.timelinePreviewSpritesPath)
  }
  for (const a of videoAssets) {
    addMain(a.storagePath)
    addMain(a.previewPath)

    const previewPath = String(a.previewPath || '').toLowerCase()
    const fileType = String(a.fileType || '').toLowerCase()
    if (fileType.startsWith('video/') && previewPath.endsWith('.mp4')) {
      const projectStoragePath = a.video.project.storagePath
        || buildProjectStorageRoot(
          a.video.project.client?.name || a.video.project.companyName || 'Client',
          a.video.project.title,
        )
      addMain(buildVideoAssetPreviewStoragePath(
        projectStoragePath,
        a.video.storageFolderName || a.video.name,
        a.video.versionLabel,
        a.storagePath || '',
        '.jpg',
      ))
    }
  }
  for (const c of commentFiles) addMain(c.storagePath)
  for (const f of shareUploadFiles) {
    addMain(f.storagePath)
    addMain(f.previewPath)
  }
  for (const folder of shareUploadFolders) {
    if (!folder.storagePath) continue
    addMain(`${folder.storagePath}/${UPLOAD_FOLDER_MARKER}`)
  }
  for (const f of projectFiles) addMain(f.storagePath)
  for (const p of albumPhotos) {
    addMain(p.storagePath)
    addMain(p.socialStoragePath)
    addMain(p.thumbnailStoragePath)
  }
  for (const album of albums) {
    const projectStoragePath = album.project.storagePath
      || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
    const albumFolderName = album.storageFolderName || album.name
    addMain(getAlbumZipStoragePath({
      projectStoragePath,
      albumFolderName,
      albumName: album.name,
      variant: 'full',
    }))

    // Social ZIPs are optional. Only require them when social downloads are enabled.
    if (album.socialCopiesEnabled) {
      addMain(getAlbumZipStoragePath({
        projectStoragePath,
        albumFolderName,
        albumName: album.name,
        variant: 'social',
      }))
    }
  }
  for (const e of projectEmails) addMain(e.rawStoragePath)
  for (const a of projectEmailAttachments) addMain(a.storagePath)
  for (const c of clientFiles) addMain(c.storagePath)
  for (const u of userFiles) addMain(u.storagePath)
  for (const u of users) addMain(u.avatarPath)
  addMain(settings?.companyLogoPath)
  addMain(settings?.companyFaviconPath)

  for (const a of accountingAttachments) {
    const relPath = a.storagePath?.trim()
    if (relPath) accountingPaths.add(relPath.replace(/\\/g, '/'))
  }

  return { mainPaths, accountingPaths, timelineSpritePrefixes }
}

/**
 * Check which referenced DB paths are absent from the active storage backend.
 * In S3 mode we compare against a pre-fetched key Set (no extra API calls).
 * In local mode we stat each path individually.
 *
 * @param mainPaths         Paths relative to STORAGE_ROOT (or S3 keys in S3 mode)
 * @param accountingPaths   Paths relative to ACCOUNTING_STORAGE_ROOT
 * @param s3KeySet          Set of all main-storage S3 keys; null in local mode
 * @param acctS3RelKeySet   Set of accounting S3 keys WITHOUT the `accounting/` prefix; null in local mode
 */
async function checkMissingFiles(
  mainPaths: Set<string>,
  accountingPaths: Set<string>,
  timelineSpritePrefixes: Set<string>,
  s3KeySet: Set<string> | null,
  acctS3RelKeySet: Set<string> | null,
): Promise<{ count: number; sample: string[] }> {
  const missing: string[] = []

  if (s3KeySet !== null) {
    // S3 mode — O(1) lookup per path, no extra API calls
    for (const relPath of mainPaths) {
      if (!s3KeySet.has(relPath)) missing.push(relPath)
    }
    for (const relPath of accountingPaths) {
      if (acctS3RelKeySet === null || !acctS3RelKeySet.has(relPath)) {
        missing.push(`${ACCOUNTING_S3_PREFIX}/${relPath}`)
      }
    }
    const spritePrefixesOnStorage = new Set<string>()
    for (const key of s3KeySet) {
      const fileName = path.posix.basename(key)
      if (!isTimelineSpriteFileName(fileName)) continue
      const match = key.match(/^(.*)\/[^/]+$/)
      if (match?.[1]) spritePrefixesOnStorage.add(match[1])
    }
    for (const prefix of timelineSpritePrefixes) {
      if (!spritePrefixesOnStorage.has(prefix)) missing.push(`${prefix}/sprite-*.jpg`)
    }
  } else {
    // Local mode — fs.access per path
    for (const relPath of mainPaths) {
      const absPath = path.join(STORAGE_ROOT, relPath)
      const exists = await fs.promises.access(absPath).then(() => true).catch(() => false)
      if (!exists) missing.push(relPath)
    }
    for (const relPath of accountingPaths) {
      const absPath = path.join(ACCOUNTING_STORAGE_ROOT, relPath)
      const exists = await fs.promises.access(absPath).then(() => true).catch(() => false)
      if (!exists) missing.push(`accounting/${relPath}`)
    }
    for (const prefix of timelineSpritePrefixes) {
      const absDir = path.join(STORAGE_ROOT, prefix)
      const names = await fs.promises.readdir(absDir).catch(() => [] as string[])
      const hasSprites = names.some(isTimelineSpriteFileName)
      if (!hasSprites) missing.push(`${prefix}/sprite-*.jpg`)
    }
  }

  return { count: missing.length, sample: missing.slice(0, 20) }
}

/**
 * Build the set of referenced accounting file paths from the database.
 * Returns relative paths (as stored in AccountingAttachment.storagePath).
 * Accepts a pre-fetched set to avoid a duplicate DB query when called from
 * cleanupProjectStorageOrphans alongside buildMissingFilesReferences().
 */
async function buildReferencedAccountingPaths(
  prefetched?: Set<string>,
): Promise<Set<string>> {
  if (prefetched) return prefetched
  const attachments = await prisma.accountingAttachment.findMany({ select: { storagePath: true } })
  const referenced = new Set<string>()
  for (const a of attachments) {
    const relPath = a.storagePath?.trim()
    if (relPath) referenced.add(relPath.replace(/\\/g, '/'))
  }
  return referenced
}

/**
 * Scan accounting storage for orphaned files (files not referenced by any AccountingAttachment).
 * Accepts pre-fetched data to avoid duplicate S3 list calls when invoked from
 * cleanupProjectStorageOrphans.
 */
async function scanAccountingOrphans(
  accountingRefPaths: Set<string>,
  stats: { scannedFiles: number },
  errors: Array<{ path: string; error: string }>,
  prefetchedS3Files?: Array<{ key: string; bytes: number }>,
): Promise<OrphanFileEntry[]> {
  const orphanFiles: OrphanFileEntry[] = []

  if (isS3Mode()) {
    let s3Files: Array<{ key: string; bytes: number }>
    if (prefetchedS3Files) {
      s3Files = prefetchedS3Files
    } else {
      try {
        s3Files = await listAccountingS3Keys()
      } catch (e: any) {
        errors.push({ path: `${ACCOUNTING_S3_PREFIX}/`, error: String(e?.message || e) })
        return orphanFiles
      }
    }

    for (const obj of s3Files) {
      stats.scannedFiles++
      // Convert S3 key (accounting/FY.../...) to relative path (FY.../...)
      const relPath = obj.key.startsWith(`${ACCOUNTING_S3_PREFIX}/`)
        ? obj.key.slice(`${ACCOUNTING_S3_PREFIX}/`.length)
        : obj.key

      if (!accountingRefPaths.has(relPath)) {
        orphanFiles.push({
          absPath: `s3://${getS3Bucket()}/${obj.key}`,
          relPath: obj.key,
          bytes: obj.bytes,
        })
      }
    }
  } else {
    let localFiles: Array<{ relPath: string; bytes: number }>
    try {
      localFiles = await listAccountingLocalFiles()
    } catch (e: any) {
      errors.push({ path: ACCOUNTING_STORAGE_ROOT, error: String(e?.message || e) })
      return orphanFiles
    }

    for (const file of localFiles) {
      stats.scannedFiles++
      if (!accountingRefPaths.has(file.relPath)) {
        orphanFiles.push({
          absPath: path.join(ACCOUNTING_STORAGE_ROOT, file.relPath),
          relPath: `accounting/${file.relPath}`,
          bytes: file.bytes,
        })
      }
    }
  }

  return orphanFiles
}

/**
 * After deleting local accounting orphan files, prune any now-empty directories
 * under ACCOUNTING_STORAGE_ROOT. These are separate from STORAGE_ROOT so the
 * main pruneEmptyDirectories function cannot handle them.
 */
async function pruneEmptyAccountingDirectories(accountingOrphans: OrphanFileEntry[]): Promise<void> {
  if (accountingOrphans.length === 0) return
  // Collect candidate directories (deepest first)
  const candidates = new Set<string>()
  const root = path.resolve(ACCOUNTING_STORAGE_ROOT)
  for (const orphan of accountingOrphans) {
    // Resolve to absolute in case ACCOUNTING_STORAGE_ROOT is a relative path
    let dir = path.dirname(path.resolve(orphan.absPath))
    while (dir !== root && dir.startsWith(root + path.sep)) {
      candidates.add(dir)
      dir = path.dirname(dir)
    }
  }

  // Sort deepest first so we prune children before parents
  const sorted = Array.from(candidates).sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
  for (const dir of sorted) {
    const children = await fs.promises.readdir(dir).catch(() => null)
    if (children && children.length === 0) {
      await fs.promises.rmdir(dir).catch(() => {})
    }
  }
}

export async function cleanupProjectStorageOrphans(dryRun: boolean): Promise<ProjectStorageOrphanCleanupResult> {
  const [refs, projectRootIndex, missingRefs] = await Promise.all([
    buildProjectStorageReferences(),
    buildProjectRootIndex(),
    buildMissingFilesReferences(),
  ])
  const errors: Array<{ path: string; error: string }> = []
  const orphanFiles: OrphanFileEntry[] = []
  const stats = { scannedFiles: 0 }
  let scannedStorageRoots = 0

  let roots: Array<{ absPath: string; relPath: string }> = []
  let missingResult: { count: number; sample: string[] } = { count: 0, sample: [] }

  // Scan storage based on configured provider
  if (isS3Mode()) {
    scannedStorageRoots = 2 // Main bucket namespace + accounting/ prefix namespace
    // Fetch both S3 listings once and share between orphan detection and missing-files check.
    const [s3Objects, accountingS3Files] = await Promise.all([
      listS3Objects(),
      listAccountingS3Keys().catch((e: any) => {
        errors.push({ path: `${ACCOUNTING_S3_PREFIX}/`, error: String(e?.message || e) })
        return [] as Array<{ key: string; bytes: number }>
      }),
    ])

    // Orphan scans (files on storage with no DB record)
    const s3Orphans = await scanS3ForOrphans(s3Objects, refs, errors, stats)
    orphanFiles.push(...s3Orphans)
    const accountingOrphans = await scanAccountingOrphans(
      missingRefs.accountingPaths,
      stats,
      errors,
      accountingS3Files,
    )
    orphanFiles.push(...accountingOrphans)

    // Missing-files check (DB records with no file on storage)
    const s3KeySet = new Set(s3Objects.map((o) => o.key))
    const acctS3RelKeySet = new Set(
      accountingS3Files.map((f) =>
        f.key.startsWith(`${ACCOUNTING_S3_PREFIX}/`)
          ? f.key.slice(`${ACCOUNTING_S3_PREFIX}/`.length)
          : f.key
      )
    )
    missingResult = await checkMissingFiles(
      missingRefs.mainPaths,
      missingRefs.accountingPaths,
      missingRefs.timelineSpritePrefixes,
      s3KeySet,
      acctS3RelKeySet,
    )
  } else {
    // Local mode: walk filesystem
    roots = await listPhysicalProjectRoots()
    scannedStorageRoots = roots.length
    for (const root of roots) {
      await walkProjectFiles(root.absPath, root.relPath, orphanFiles, refs, errors, stats)
    }
    // Accounting orphans
    const accountingOrphans = await scanAccountingOrphans(missingRefs.accountingPaths, stats, errors)
    orphanFiles.push(...accountingOrphans)

    // Missing-files check (local)
    missingResult = await checkMissingFiles(
      missingRefs.mainPaths,
      missingRefs.accountingPaths,
      missingRefs.timelineSpritePrefixes,
      null,
      null,
    )
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
      scannedDirectories: scannedStorageRoots,
      scannedProjects: projectRootIndex.size,
      scannedFiles: stats.scannedFiles,
      orphanFiles: orphanFiles.length,
      orphanFileBytes,
      missingFiles: missingResult.count,
      missingFileSample: missingResult.count > 0 ? { paths: missingResult.sample } : undefined,
      sample: {
        orphanPaths: orphanFiles.slice(0, 20).map((file) => file.relPath),
        projectIds: sampleProjectIds,
      },
      errors: errors.length ? errors.slice(0, 50) : undefined,
    }
  }

  let filesDeleted = 0
  let filesFailed = 0

  if (isS3Mode()) {
    // Delete orphan files from S3 only (missing files can't be deleted — they don't exist)
    for (const orphanFile of orphanFiles) {
      try {
        await s3DeleteFile(orphanFile.relPath)
        filesDeleted++
      } catch (error: any) {
        filesFailed++
        errors.push({ path: orphanFile.relPath, error: String(error?.message || error) })
      }
    }

    // For S3 mode, no empty dir pruning needed
    return {
      ok: true,
      dryRun: false,
      scannedDirectories: scannedStorageRoots,
      scannedProjects: projectRootIndex.size,
      scannedFiles: stats.scannedFiles,
      orphanFiles: orphanFiles.length,
      orphanFileBytes,
      missingFiles: missingResult.count,
      missingFileSample: missingResult.count > 0 ? { paths: missingResult.sample } : undefined,
      sample: {
        orphanPaths: orphanFiles.slice(0, 20).map((file) => file.relPath),
        projectIds: sampleProjectIds,
      },
      deleted: {
        filesDeleted,
        filesFailed,
        emptyDirsPruned: 0,
      },
      errors: errors.length ? errors.slice(0, 50) : undefined,
    }
  }

  // Delete orphan files from local filesystem
  for (const orphanFile of orphanFiles) {
    try {
      await fs.promises.unlink(orphanFile.absPath)
      filesDeleted++
    } catch (error: any) {
      filesFailed++
      errors.push({ path: orphanFile.relPath, error: String(error?.message || error) })
    }
  }

  // Prune empty directories (local only — S3 has no directory concept)
  // Split main-storage orphans from accounting orphans since they live under different roots.
  const mainOrphans = orphanFiles.filter((f) => !f.relPath.startsWith('accounting/'))
  const accountingLocalOrphans = orphanFiles.filter((f) => f.relPath.startsWith('accounting/'))
  const emptyDirsPruned = await pruneEmptyDirectories(buildDirPruneCandidates(mainOrphans), false)
  await pruneEmptyAccountingDirectories(accountingLocalOrphans)

  return {
    ok: true,
    dryRun: false,
    scannedDirectories: scannedStorageRoots,
    scannedProjects: projectRootIndex.size,
    scannedFiles: stats.scannedFiles,
    orphanFiles: orphanFiles.length,
    orphanFileBytes,
    missingFiles: missingResult.count,
    missingFileSample: missingResult.count > 0 ? { paths: missingResult.sample } : undefined,
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