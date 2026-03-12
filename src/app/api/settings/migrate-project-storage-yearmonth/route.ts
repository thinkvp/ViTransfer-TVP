import * as fs from 'fs'
import * as path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getRawStoragePath, moveDirectory, STORAGE_ROOT } from '@/lib/storage'
import {
  allocateUniqueStorageName,
  buildAlbumStorageRoot,
  buildProjectStorageRoot,
  buildVideoAssetStoragePath,
  buildVideoOriginalStoragePath,
  buildVideoPreviewStoragePath,
  buildVideoThumbnailStoragePath,
  buildVideoTimelineStorageRoot,
  buildVideoVersionRoot,
  replaceStoragePathPrefix,
} from '@/lib/project-storage-paths'

export const runtime = 'nodejs'

type MigrationError = { projectId?: string; path?: string; error: string }

type MigrationResult = {
  ok: true
  dryRun: boolean
  projectsChecked: number
  projectsMigrated: number
  projectsAlreadyCanonical: number
  projectsWithoutClient: number
  projectsWithoutExistingRoot: number
  projectRootsMoved: number
  videoFoldersNormalized: number
  assetFilesNormalized: number
  albumFoldersNormalized: number
  recordsUpdated: number
  legacyFolderCleanup?: {
    removed: string[]
    skippedNonEmpty: boolean
  }
  sample?: {
    migratedProjects: Array<{ id: string; title: string; targetPath: string }>
    skippedProjects: Array<{ id: string; title: string; reason: string }>
  }
  errors?: MigrationError[]
}

type ProjectSummary = {
  id: string
  title: string
  createdAt: Date
  clientId: string | null
  companyName: string | null
  storagePath: string | null
  client: { name: string } | null
}

function toYearMonthUTC(dateLike: Date) {
  const yyyy = dateLike.getUTCFullYear()
  const mm = String(dateLike.getUTCMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}`
}

/**
 * Sanitize a relative storage path for filesystem access by replacing
 * characters that validatePathBase rejects (e.g. colons from legacy titles).
 * This mirrors the substitution that sanitizeStorageName applies when
 * building canonical paths.
 */
function sanitizeRelPathForFs(relPath: string): string {
  return relPath.replace(/:/g, '_')
}

function existsRel(relPath: string | null | undefined): boolean {
  if (!relPath) return false
  try {
    return fs.existsSync(getRawStoragePath(sanitizeRelPathForFs(relPath)))
  } catch {
    return false
  }
}

function pickExistingRel(paths: Array<string | null | undefined>): string | null {
  for (const relPath of paths) {
    if (existsRel(relPath)) return relPath || null
  }
  return null
}

function rebaseProjectPath(currentPath: string | null | undefined, oldRoot: string | null, newRoot: string): string | null {
  if (!currentPath) return null
  if (oldRoot) {
    return replaceStoragePathPrefix(currentPath, oldRoot, newRoot)
  }
  return currentPath
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of paths) {
    const value = String(raw || '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripLegacyUploadPrefix(fileName: string): string {
  return fileName.replace(/^(?:original|asset|photo)-\d+-/, '')
}

function findLegacyPrefixedFileInDir(dirRel: string, suffix: string): string | null {
  if (!dirRel || !suffix) return null

  try {
    const dirAbs = getRawStoragePath(sanitizeRelPathForFs(dirRel))
    if (!fs.existsSync(dirAbs)) return null

    const matcher = new RegExp(`^(?:original|asset|photo)-\\d+-${escapeRegExp(suffix)}$`, 'i')
    const match = fs.readdirSync(dirAbs, { withFileTypes: true })
      .find((entry) => entry.isFile() && matcher.test(entry.name))

    return match ? path.posix.join(dirRel, match.name) : null
  } catch {
    return null
  }
}

async function moveFileRel(fromRel: string, toRel: string, dryRun: boolean): Promise<boolean> {
  if (!fromRel || !toRel || fromRel === toRel) return false

  const sanitizedFrom = sanitizeRelPathForFs(fromRel)
  const fromAbs = getRawStoragePath(sanitizedFrom)
  if (!fs.existsSync(fromAbs)) return false

  const toAbs = getRawStoragePath(toRel)
  if (fs.existsSync(toAbs)) return false

  if (dryRun) return true

  await fs.promises.mkdir(path.dirname(toAbs), { recursive: true })
  try {
    await fs.promises.rename(fromAbs, toAbs)
  } catch (error: any) {
    if (error?.code === 'EXDEV') {
      await fs.promises.copyFile(fromAbs, toAbs)
      await fs.promises.unlink(fromAbs)
    } else {
      throw error
    }
  }

  return true
}

/**
 * Wrapper around moveDirectory that sanitizes the `from` path segment
 * (which may contain legacy colons from DB) before hitting the filesystem.
 */
async function moveDirectorySanitized(
  fromRel: string,
  toRel: string,
  options?: { merge?: boolean },
): Promise<void> {
  const sanitizedFrom = sanitizeRelPathForFs(fromRel)
  return moveDirectory(sanitizedFrom, toRel, options)
}

async function normalizeProjectStorage(opts: {
  project: ProjectSummary
  targetProjectStoragePath: string
  dryRun: boolean
  errors: MigrationError[]
}): Promise<{
  migrated: boolean
  alreadyCanonical: boolean
  missingRoot: boolean
  projectRootMoved: number
  videoFoldersNormalized: number
  assetFilesNormalized: number
  albumFoldersNormalized: number
  recordsUpdated: number
}> {
  const { project, targetProjectStoragePath, dryRun } = opts
  const fallbackRootCandidates = [
    project.storagePath,
    `projects/${project.id}`,
    `projects/${toYearMonthUTC(project.createdAt)}/${project.id}`,
    `projects/closed/${toYearMonthUTC(project.createdAt)}/${project.id}`,
  ]
  const existingProjectRoot = pickExistingRel(fallbackRootCandidates)

  const fullProject = await prisma.project.findUnique({
    where: { id: project.id },
    select: {
      id: true,
      storagePath: true,
      videos: {
        select: {
          id: true,
          name: true,
          version: true,
          versionLabel: true,
          originalFileName: true,
          originalStoragePath: true,
          preview480Path: true,
          preview720Path: true,
          preview1080Path: true,
          thumbnailPath: true,
          timelinePreviewVttPath: true,
          timelinePreviewSpritesPath: true,
          storageFolderName: true,
          assets: {
            select: {
              id: true,
              fileName: true,
              storagePath: true,
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { version: 'asc' }],
      },
      albums: {
        select: {
          id: true,
          name: true,
          storageFolderName: true,
          photos: {
            select: {
              id: true,
              fileName: true,
              storagePath: true,
              socialStoragePath: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      files: { select: { id: true, storagePath: true } },
      emails: {
        select: {
          id: true,
          rawStoragePath: true,
          attachments: { select: { id: true, storagePath: true } },
        },
      },
      commentFiles: { select: { id: true, storagePath: true } },
    },
  })

  if (!fullProject) {
    throw new Error('Project not found during migration')
  }

  let projectRootMoved = 0
  let videoFoldersNormalized = 0
  let assetFilesNormalized = 0
  let albumFoldersNormalized = 0
  let recordsUpdated = 0

  if (existingProjectRoot && existingProjectRoot !== targetProjectStoragePath) {
    projectRootMoved = 1
    if (!dryRun) {
      await moveDirectorySanitized(existingProjectRoot, targetProjectStoragePath)
    }
  }

  const workingProjectRoot = targetProjectStoragePath
  const oldProjectRootForRebase = existingProjectRoot

  const usedVideoFolders: string[] = []
  const videoGroupFolderByName = new Map<string, string>()
  const videoNameOrder = Array.from(new Set(fullProject.videos.map((video) => video.name)))
  for (const videoName of videoNameOrder) {
    const nextFolder = allocateUniqueStorageName(videoName, usedVideoFolders)
    usedVideoFolders.push(nextFolder)
    videoGroupFolderByName.set(videoName, nextFolder)
  }

  const usedAlbumFolders: string[] = []
  const albumFolderById = new Map<string, string>()
  for (const album of fullProject.albums) {
    const nextFolder = allocateUniqueStorageName(album.name, usedAlbumFolders)
    usedAlbumFolders.push(nextFolder)
    albumFolderById.set(album.id, nextFolder)
  }

  const videoUpdates = new Map<string, Record<string, string | null>>()
  const assetUpdates = new Map<string, string>()
  const albumUpdates = new Map<string, string>()
  const photoUpdates = new Map<string, { fileName: string; storagePath: string; socialStoragePath: string | null }>()
  const projectFileUpdates = new Map<string, string>()
  const emailUpdates = new Map<string, string>()
  const attachmentUpdates = new Map<string, string>()
  const commentFileUpdates = new Map<string, string>()

  for (const video of fullProject.videos) {
    try {
    const desiredVideoFolder = videoGroupFolderByName.get(video.name) || video.name
    const desiredVersionRoot = buildVideoVersionRoot(workingProjectRoot, desiredVideoFolder, video.versionLabel)
    const currentOriginalPath = rebaseProjectPath(video.originalStoragePath, oldProjectRootForRebase, workingProjectRoot) || video.originalStoragePath
    const current480FromDb = rebaseProjectPath(video.preview480Path, oldProjectRootForRebase, workingProjectRoot)
    const current720FromDb = rebaseProjectPath(video.preview720Path, oldProjectRootForRebase, workingProjectRoot)
    const current1080FromDb = rebaseProjectPath(video.preview1080Path, oldProjectRootForRebase, workingProjectRoot)
    const currentThumbnailFromDb = rebaseProjectPath(video.thumbnailPath, oldProjectRootForRebase, workingProjectRoot)
    const currentTimelineSpritesFromDb = rebaseProjectPath(video.timelinePreviewSpritesPath, oldProjectRootForRebase, workingProjectRoot)
    const currentTimelineVttFromDb = rebaseProjectPath(video.timelinePreviewVttPath, oldProjectRootForRebase, workingProjectRoot)
    const originalBaseName = path.posix.basename(currentOriginalPath || video.originalFileName || '')
    const legacyVideoIdRoot = path.posix.join(workingProjectRoot, 'videos', video.id)
    const legacyNamedRoot = path.posix.join(workingProjectRoot, 'videos', video.storageFolderName || video.name)
    const sharedVideosRoot = path.posix.join(workingProjectRoot, 'videos')
    const desiredVersionAlreadyNested = desiredVersionRoot.startsWith(`${legacyNamedRoot}/`) && existsRel(desiredVersionRoot)
    const currentVersionRoot = pickExistingRel(uniquePaths([
      current480FromDb ? path.posix.dirname(current480FromDb) : null,
      current720FromDb ? path.posix.dirname(current720FromDb) : null,
      current1080FromDb ? path.posix.dirname(current1080FromDb) : null,
      currentThumbnailFromDb ? path.posix.dirname(currentThumbnailFromDb) : null,
      currentTimelineSpritesFromDb ? path.posix.dirname(currentTimelineSpritesFromDb) : null,
      currentTimelineVttFromDb ? path.posix.dirname(currentTimelineVttFromDb) : null,
      legacyVideoIdRoot,
      desiredVersionAlreadyNested ? null : legacyNamedRoot,
      desiredVersionRoot,
    ]))

    if (currentVersionRoot && currentVersionRoot !== desiredVersionRoot) {
      videoFoldersNormalized += 1
      if (!dryRun) {
        await moveDirectorySanitized(currentVersionRoot, desiredVersionRoot, { merge: true })
      }
    }

    const assetTargetByCurrentPath = new Map<string, string>()
    for (const asset of video.assets) {
      const currentAssetPath = rebaseProjectPath(asset.storagePath, oldProjectRootForRebase, workingProjectRoot) || asset.storagePath
      const desiredAssetPath = buildVideoAssetStoragePath(
        workingProjectRoot,
        desiredVideoFolder,
        video.versionLabel,
        asset.fileName,
      )
      const resolvedCurrentAssetPath = pickExistingRel(uniquePaths([
        currentVersionRoot ? replaceStoragePathPrefix(currentAssetPath, currentVersionRoot, desiredVersionRoot) : currentAssetPath,
        currentAssetPath,
        `${legacyVideoIdRoot}/assets/${asset.fileName}`,
        `${legacyNamedRoot}/assets/${asset.fileName}`,
        desiredAssetPath,
      ])) || currentAssetPath
      if (resolvedCurrentAssetPath !== desiredAssetPath) {
        assetFilesNormalized += 1
        if (!dryRun) {
          await moveFileRel(resolvedCurrentAssetPath, desiredAssetPath, false)
        }
      }
      assetTargetByCurrentPath.set(resolvedCurrentAssetPath, desiredAssetPath)
      if (asset.storagePath !== desiredAssetPath) {
        assetUpdates.set(asset.id, desiredAssetPath)
      }
    }

    const desiredOriginalPath = buildVideoOriginalStoragePath(
      workingProjectRoot,
      desiredVideoFolder,
      video.versionLabel,
      video.originalFileName,
    )
    const cleanOriginalFileName = stripLegacyUploadPrefix(video.originalFileName)
    const legacyPrefixedOriginalPath = findLegacyPrefixedFileInDir(sharedVideosRoot, cleanOriginalFileName)
      || findLegacyPrefixedFileInDir(legacyVideoIdRoot, cleanOriginalFileName)
      || findLegacyPrefixedFileInDir(legacyNamedRoot, cleanOriginalFileName)
    const currentOriginalAfterRootMove = pickExistingRel(uniquePaths([
      currentVersionRoot ? replaceStoragePathPrefix(currentOriginalPath, currentVersionRoot, desiredVersionRoot) : currentOriginalPath,
      currentOriginalPath,
      originalBaseName ? `${sharedVideosRoot}/${originalBaseName}` : null,
      originalBaseName ? `${legacyVideoIdRoot}/${originalBaseName}` : null,
      originalBaseName ? `${legacyNamedRoot}/${originalBaseName}` : null,
      legacyPrefixedOriginalPath,
      desiredOriginalPath,
    ])) || currentOriginalPath
    if (currentOriginalAfterRootMove !== desiredOriginalPath && !dryRun) {
      await moveFileRel(currentOriginalAfterRootMove, desiredOriginalPath, false)
    }

    const current480 = pickExistingRel(uniquePaths([
      currentVersionRoot && current480FromDb ? replaceStoragePathPrefix(current480FromDb, currentVersionRoot, desiredVersionRoot) : current480FromDb,
      current480FromDb,
      `${legacyVideoIdRoot}/preview-480p.mp4`,
      `${legacyNamedRoot}/preview-480p.mp4`,
    ]))
    const current720 = pickExistingRel(uniquePaths([
      currentVersionRoot && current720FromDb ? replaceStoragePathPrefix(current720FromDb, currentVersionRoot, desiredVersionRoot) : current720FromDb,
      current720FromDb,
      `${legacyVideoIdRoot}/preview-720p.mp4`,
      `${legacyNamedRoot}/preview-720p.mp4`,
    ]))
    const current1080 = pickExistingRel(uniquePaths([
      currentVersionRoot && current1080FromDb ? replaceStoragePathPrefix(current1080FromDb, currentVersionRoot, desiredVersionRoot) : current1080FromDb,
      current1080FromDb,
      `${legacyVideoIdRoot}/preview-1080p.mp4`,
      `${legacyNamedRoot}/preview-1080p.mp4`,
    ]))
    const desired480 = video.preview480Path ? buildVideoPreviewStoragePath(workingProjectRoot, desiredVideoFolder, video.versionLabel, '480p') : null
    const desired720 = video.preview720Path ? buildVideoPreviewStoragePath(workingProjectRoot, desiredVideoFolder, video.versionLabel, '720p') : null
    const desired1080 = video.preview1080Path ? buildVideoPreviewStoragePath(workingProjectRoot, desiredVideoFolder, video.versionLabel, '1080p') : null

    if (current480 && desired480 && current480 !== desired480 && !dryRun) await moveFileRel(current480, desired480, false)
    if (current720 && desired720 && current720 !== desired720 && !dryRun) await moveFileRel(current720, desired720, false)
    if (current1080 && desired1080 && current1080 !== desired1080 && !dryRun) await moveFileRel(current1080, desired1080, false)

    const currentSpritesPath = pickExistingRel(uniquePaths([
      currentVersionRoot && currentTimelineSpritesFromDb ? replaceStoragePathPrefix(currentTimelineSpritesFromDb, currentVersionRoot, desiredVersionRoot) : currentTimelineSpritesFromDb,
      currentTimelineSpritesFromDb,
      `${legacyVideoIdRoot}/timeline-previews`,
      `${legacyNamedRoot}/timeline-previews`,
    ]))
    const desiredSpritesPath = video.timelinePreviewSpritesPath
      ? buildVideoTimelineStorageRoot(workingProjectRoot, desiredVideoFolder, video.versionLabel)
      : null
    if (currentSpritesPath && desiredSpritesPath && currentSpritesPath !== desiredSpritesPath && !dryRun) {
      await moveDirectorySanitized(currentSpritesPath, desiredSpritesPath, { merge: true })
    }

    const currentThumbnailPath = pickExistingRel(uniquePaths([
      currentVersionRoot && currentThumbnailFromDb ? replaceStoragePathPrefix(currentThumbnailFromDb, currentVersionRoot, desiredVersionRoot) : currentThumbnailFromDb,
      currentThumbnailFromDb,
      `${legacyVideoIdRoot}/thumbnail.jpg`,
      `${legacyNamedRoot}/thumbnail.jpg`,
    ]))
    let desiredThumbnailPath: string | null = currentThumbnailPath
    if (currentThumbnailPath && assetTargetByCurrentPath.has(currentThumbnailPath)) {
      desiredThumbnailPath = assetTargetByCurrentPath.get(currentThumbnailPath) || currentThumbnailPath
    } else if (currentThumbnailPath) {
      const movedThumbnailPath = currentVersionRoot
        ? (replaceStoragePathPrefix(currentThumbnailPath, currentVersionRoot, desiredVersionRoot) || currentThumbnailPath)
        : currentThumbnailPath
      const systemThumbnailPath = buildVideoThumbnailStoragePath(workingProjectRoot, desiredVideoFolder, video.versionLabel)
      desiredThumbnailPath = systemThumbnailPath
      if (movedThumbnailPath !== systemThumbnailPath && !dryRun) {
        await moveFileRel(movedThumbnailPath, systemThumbnailPath, false)
      }
    }

    const nextVideoData: Record<string, string | null> = {
      storageFolderName: desiredVideoFolder,
      originalStoragePath: desiredOriginalPath,
      preview480Path: desired480,
      preview720Path: desired720,
      preview1080Path: desired1080,
      thumbnailPath: desiredThumbnailPath,
      timelinePreviewSpritesPath: desiredSpritesPath,
      timelinePreviewVttPath: desiredSpritesPath ? `${desiredSpritesPath}/index.vtt` : null,
    }

    if (
      video.storageFolderName !== nextVideoData.storageFolderName
      || video.originalStoragePath !== nextVideoData.originalStoragePath
      || video.preview480Path !== nextVideoData.preview480Path
      || video.preview720Path !== nextVideoData.preview720Path
      || video.preview1080Path !== nextVideoData.preview1080Path
      || video.thumbnailPath !== nextVideoData.thumbnailPath
      || video.timelinePreviewSpritesPath !== nextVideoData.timelinePreviewSpritesPath
      || video.timelinePreviewVttPath !== nextVideoData.timelinePreviewVttPath
    ) {
      videoUpdates.set(video.id, nextVideoData)
    }
    } catch (err: any) {
      opts.errors.push({ projectId: project.id, path: video.originalStoragePath || video.id, error: `Video "${video.name}": ${err?.message || err}` })
    }
  }

  for (const album of fullProject.albums) {
    try {
    const desiredAlbumFolder = albumFolderById.get(album.id) || album.name
    const currentPhotoPath = album.photos[0]?.storagePath
      ? rebaseProjectPath(album.photos[0].storagePath, oldProjectRootForRebase, workingProjectRoot)
      : null
    const legacyAlbumIdRoot = path.posix.join(workingProjectRoot, 'albums', album.id)
    const legacyNamedRoot = path.posix.join(workingProjectRoot, 'albums', album.storageFolderName || album.name)
    const desiredAlbumRoot = buildAlbumStorageRoot(workingProjectRoot, desiredAlbumFolder)
    const oldAlbumRoot = pickExistingRel(uniquePaths([
      currentPhotoPath ? path.posix.dirname(currentPhotoPath) : null,
      legacyNamedRoot,
      legacyAlbumIdRoot,
      desiredAlbumRoot,
    ])) || legacyNamedRoot
    const newAlbumRoot = buildAlbumStorageRoot(workingProjectRoot, desiredAlbumFolder)

    if (oldAlbumRoot !== newAlbumRoot) {
      albumFoldersNormalized += 1
      if (!dryRun) {
        await moveDirectorySanitized(oldAlbumRoot, newAlbumRoot)
      }
    }

    if (album.storageFolderName !== desiredAlbumFolder) {
      albumUpdates.set(album.id, desiredAlbumFolder)
    }

    const usedPhotoFileNames: string[] = []

    for (const photo of album.photos) {
      const rebasedPhotoPath = rebaseProjectPath(photo.storagePath, oldProjectRootForRebase, workingProjectRoot)
      const rebasedSocialPath = rebaseProjectPath(photo.socialStoragePath, oldProjectRootForRebase, workingProjectRoot)
      const desiredPhotoFileName = allocateUniqueStorageName(stripLegacyUploadPrefix(photo.fileName), usedPhotoFileNames)
      usedPhotoFileNames.push(desiredPhotoFileName)
      const desiredStoragePath = path.posix.join(newAlbumRoot, desiredPhotoFileName)
      const legacyPrefixedStoragePath = findLegacyPrefixedFileInDir(newAlbumRoot, desiredPhotoFileName)
        || findLegacyPrefixedFileInDir(oldAlbumRoot, desiredPhotoFileName)
      const currentStoragePath = pickExistingRel(uniquePaths([
        replaceStoragePathPrefix(rebasedPhotoPath, oldAlbumRoot, newAlbumRoot),
        rebasedPhotoPath,
        legacyPrefixedStoragePath,
        photo.fileName ? `${legacyAlbumIdRoot}/${photo.fileName}` : null,
        photo.fileName ? `${legacyNamedRoot}/${photo.fileName}` : null,
        desiredStoragePath,
      ])) || (replaceStoragePathPrefix(rebasedPhotoPath, oldAlbumRoot, newAlbumRoot) || photo.storagePath)
      if (currentStoragePath !== desiredStoragePath && !dryRun) {
        await moveFileRel(currentStoragePath, desiredStoragePath, false)
      }

      const desiredSocialStoragePath = photo.socialStoragePath ? `${desiredStoragePath}-social.jpg` : null
      const legacyPrefixedSocialStoragePath = desiredSocialStoragePath
        ? (findLegacyPrefixedFileInDir(newAlbumRoot, `${desiredPhotoFileName}-social.jpg`)
          || findLegacyPrefixedFileInDir(oldAlbumRoot, `${desiredPhotoFileName}-social.jpg`))
        : null
      const currentSocialStoragePath = desiredSocialStoragePath
        ? pickExistingRel(uniquePaths([
            replaceStoragePathPrefix(rebasedSocialPath, oldAlbumRoot, newAlbumRoot),
            rebasedSocialPath,
            currentStoragePath ? `${currentStoragePath}-social.jpg` : null,
            legacyPrefixedSocialStoragePath,
            desiredSocialStoragePath,
          ])) || replaceStoragePathPrefix(rebasedSocialPath, oldAlbumRoot, newAlbumRoot)
        : null

      if (
        desiredSocialStoragePath
        && currentSocialStoragePath
        && currentSocialStoragePath !== desiredSocialStoragePath
        && !dryRun
      ) {
        await moveFileRel(currentSocialStoragePath, desiredSocialStoragePath, false)
      }

      if (
        photo.fileName !== desiredPhotoFileName
        || photo.storagePath !== desiredStoragePath
        || photo.socialStoragePath !== desiredSocialStoragePath
      ) {
        photoUpdates.set(photo.id, {
          fileName: desiredPhotoFileName,
          storagePath: desiredStoragePath,
          socialStoragePath: desiredSocialStoragePath,
        })
      }
    }
    } catch (err: any) {
      opts.errors.push({ projectId: project.id, path: album.id, error: `Album "${album.name}": ${err?.message || err}` })
    }
  }

  for (const file of fullProject.files) {
    const nextPath = rebaseProjectPath(file.storagePath, oldProjectRootForRebase, workingProjectRoot) || file.storagePath
    if (file.storagePath !== nextPath) {
      projectFileUpdates.set(file.id, nextPath)
    }
  }

  for (const email of fullProject.emails) {
    const nextRawPath = rebaseProjectPath(email.rawStoragePath, oldProjectRootForRebase, workingProjectRoot) || email.rawStoragePath
    if (email.rawStoragePath !== nextRawPath) {
      emailUpdates.set(email.id, nextRawPath)
    }
    for (const attachment of email.attachments) {
      const nextAttachmentPath = rebaseProjectPath(attachment.storagePath, oldProjectRootForRebase, workingProjectRoot) || attachment.storagePath
      if (attachment.storagePath !== nextAttachmentPath) {
        attachmentUpdates.set(attachment.id, nextAttachmentPath)
      }
    }
  }

  for (const commentFile of fullProject.commentFiles) {
    const nextPath = rebaseProjectPath(commentFile.storagePath, oldProjectRootForRebase, workingProjectRoot) || commentFile.storagePath
    if (commentFile.storagePath !== nextPath) {
      commentFileUpdates.set(commentFile.id, nextPath)
    }
  }

  const projectNeedsUpdate = project.storagePath !== targetProjectStoragePath
  const totalPlannedUpdates =
    (projectNeedsUpdate ? 1 : 0)
    + videoUpdates.size
    + assetUpdates.size
    + albumUpdates.size
    + photoUpdates.size
    + projectFileUpdates.size
    + emailUpdates.size
    + attachmentUpdates.size
    + commentFileUpdates.size

  recordsUpdated = totalPlannedUpdates

  if (!dryRun && totalPlannedUpdates > 0) {
    await prisma.$transaction(async (tx) => {
      if (projectNeedsUpdate) {
        await tx.project.update({
          where: { id: project.id },
          data: { storagePath: targetProjectStoragePath },
        })
      }

      for (const [videoId, data] of videoUpdates) {
        await tx.video.update({ where: { id: videoId }, data })
      }
      for (const [assetId, storagePath] of assetUpdates) {
        await tx.videoAsset.update({ where: { id: assetId }, data: { storagePath } })
      }
      for (const [albumId, storageFolderName] of albumUpdates) {
        await tx.album.update({ where: { id: albumId }, data: { storageFolderName } })
      }
      for (const [photoId, data] of photoUpdates) {
        await tx.albumPhoto.update({ where: { id: photoId }, data })
      }
      for (const [fileId, storagePath] of projectFileUpdates) {
        await tx.projectFile.update({ where: { id: fileId }, data: { storagePath } })
      }
      for (const [emailId, rawStoragePath] of emailUpdates) {
        await tx.projectEmail.update({ where: { id: emailId }, data: { rawStoragePath } })
      }
      for (const [attachmentId, storagePath] of attachmentUpdates) {
        await tx.projectEmailAttachment.update({ where: { id: attachmentId }, data: { storagePath } })
      }
      for (const [commentFileId, storagePath] of commentFileUpdates) {
        await tx.commentFile.update({ where: { id: commentFileId }, data: { storagePath } })
      }
    })
  }

  const migrated = projectRootMoved > 0 || videoFoldersNormalized > 0 || assetFilesNormalized > 0 || albumFoldersNormalized > 0 || recordsUpdated > 0
  const alreadyCanonical = !migrated && existingProjectRoot === targetProjectStoragePath && !projectNeedsUpdate
  const missingRoot = !existingProjectRoot

  return {
    migrated,
    alreadyCanonical,
    missingRoot,
    projectRootMoved,
    videoFoldersNormalized,
    assetFilesNormalized,
    albumFoldersNormalized,
    recordsUpdated,
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'migrate-project-storage-yearmonth'
  )
  if (rateLimitResult) return rateLimitResult

  let dryRun = true
  try {
    const body = await request.json().catch(() => ({}))
    dryRun = body?.dryRun !== false
  } catch {
    // ignore
  }

  const errors: MigrationError[] = []
  const migratedProjects: Array<{ id: string; title: string; targetPath: string }> = []
  const skippedProjects: Array<{ id: string; title: string; reason: string }> = []

  const projects = await prisma.project.findMany({
    select: {
      id: true,
      title: true,
      createdAt: true,
      clientId: true,
      companyName: true,
      storagePath: true,
      client: { select: { name: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { title: 'asc' }],
  }) as ProjectSummary[]

  const usedProjectFoldersByClient = new Map<string, string[]>()
  let projectsMigrated = 0
  let projectsAlreadyCanonical = 0
  let projectsWithoutClient = 0
  let projectsWithoutExistingRoot = 0
  let projectRootsMoved = 0
  let videoFoldersNormalized = 0
  let assetFilesNormalized = 0
  let albumFoldersNormalized = 0
  let recordsUpdated = 0

  for (const project of projects) {
    const clientName = project.client?.name || null
    if (!project.clientId || !clientName) {
      projectsWithoutClient += 1
      if (skippedProjects.length < 10) {
        skippedProjects.push({ id: project.id, title: project.title, reason: 'Project has no client' })
      }
      continue
    }

    try {
      const usedProjectFolders = usedProjectFoldersByClient.get(project.clientId) || []
      const nextProjectFolderName = allocateUniqueStorageName(project.title, usedProjectFolders)
      usedProjectFolders.push(nextProjectFolderName)
      usedProjectFoldersByClient.set(project.clientId, usedProjectFolders)
      const targetProjectStoragePath = buildProjectStorageRoot(clientName, nextProjectFolderName)

      const outcome = await normalizeProjectStorage({
        project,
        targetProjectStoragePath,
        dryRun,
        errors,
      })

      if (outcome.migrated) {
        projectsMigrated += 1
        projectRootsMoved += outcome.projectRootMoved
        videoFoldersNormalized += outcome.videoFoldersNormalized
        assetFilesNormalized += outcome.assetFilesNormalized
        albumFoldersNormalized += outcome.albumFoldersNormalized
        recordsUpdated += outcome.recordsUpdated
        if (migratedProjects.length < 10) {
          migratedProjects.push({ id: project.id, title: project.title, targetPath: targetProjectStoragePath })
        }
      } else if (outcome.alreadyCanonical) {
        projectsAlreadyCanonical += 1
      }

      if (outcome.missingRoot) {
        projectsWithoutExistingRoot += 1
      }
    } catch (error: any) {
      errors.push({ projectId: project.id, path: project.storagePath || undefined, error: String(error?.message || error) })
    }
  }

  // Clean up legacy projects/ folder after successful migration
  let legacyFolderCleanup: MigrationResult['legacyFolderCleanup'] = undefined
  if (!dryRun && errors.length === 0) {
    legacyFolderCleanup = await cleanupLegacyProjectsFolder()
  }

  const result: MigrationResult = {
    ok: true,
    dryRun,
    projectsChecked: projects.length,
    projectsMigrated,
    projectsAlreadyCanonical,
    projectsWithoutClient,
    projectsWithoutExistingRoot,
    projectRootsMoved,
    videoFoldersNormalized,
    assetFilesNormalized,
    albumFoldersNormalized,
    recordsUpdated,
    ...(legacyFolderCleanup ? { legacyFolderCleanup } : {}),
    sample: {
      migratedProjects,
      skippedProjects,
    },
    ...(errors.length ? { errors } : {}),
  }

  return NextResponse.json(result)
}

/**
 * Remove the legacy projects/ folder and its metadata files after
 * all projects have been migrated to the clients/ layout.
 */
async function cleanupLegacyProjectsFolder(): Promise<{ removed: string[]; skippedNonEmpty: boolean }> {
  const projectsRoot = path.join(STORAGE_ROOT, 'projects')
  const removed: string[] = []
  let skippedNonEmpty = false

  if (!fs.existsSync(projectsRoot)) {
    return { removed, skippedNonEmpty }
  }

  // Helper: recursively remove empty directories and known metadata files
  async function pruneDir(dirAbs: string): Promise<boolean> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return false
    }

    let allRemoved = true
    for (const entry of entries) {
      const childAbs = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        const childEmpty = await pruneDir(childAbs)
        if (!childEmpty) {
          allRemoved = false
        }
      } else if (isLegacyMetadataFile(entry.name)) {
        await fs.promises.rm(childAbs, { force: true })
        removed.push(path.relative(STORAGE_ROOT, childAbs).replace(/\\/g, '/'))
      } else {
        // Real data file still present
        allRemoved = false
      }
    }

    if (allRemoved) {
      await fs.promises.rm(dirAbs, { recursive: true, force: true })
      const rel = path.relative(STORAGE_ROOT, dirAbs).replace(/\\/g, '/')
      if (rel === 'projects') {
        removed.push('projects/')
      }
      return true
    }

    skippedNonEmpty = true
    return false
  }

  await pruneDir(projectsRoot)
  return { removed, skippedNonEmpty }
}

function isLegacyMetadataFile(name: string): boolean {
  return (
    name === '.vitransfer_projects_redirects.json' ||
    name === '.vitransfer_project_redirect' ||
    name === '.vitransfer_closed_index.json' ||
    name.endsWith('.tmp') ||
    name.startsWith('.vitransfer_')
  )
}
