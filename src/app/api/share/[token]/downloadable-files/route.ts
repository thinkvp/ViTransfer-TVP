import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { getAlbumZipFileName } from '@/lib/album-photo-zip'
import { generateAlbumPhotoAccessToken } from '@/lib/photo-access'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import { generateVideoAccessToken } from '@/lib/video-access'
import type { DownloadableFile, DownloadableGroup, DownloadableFilesResult } from '@/lib/downloadable-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function asNumberBigInt(v: unknown): number {
  if (typeof v === 'bigint') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

interface ShareUploadFileRow {
  id: string
  folderRelativePath: string
  fileName: string
  fileSize: bigint
  fileType: string
  mediaDurationSeconds: number | null
  previewStatus: string | null
  timelinePreviewsReady: boolean | null
  timelinePreviewVttPath: string | null
  timelinePreviewSpritesPath: string | null
}

interface ShareUploadFolderRow {
  relativePath: string
}

// GET /api/share/[token]/downloadable-files
// Returns approved video files + assets and album zip files available for download.
// Requires authentication; guest sessions are blocked (403).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    `share-downloadable-files:${token}`
  )
  if (rateLimitResult) return rateLimitResult

  const projectMeta = await prisma.project.findUnique({
    where: { slug: token },
    select: { id: true, sharePassword: true, authMode: true, enableClientUploads: true },
  })

  if (!projectMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const accessCheck = await verifyProjectAccess(
    request,
    projectMeta.id,
    projectMeta.sharePassword,
    projectMeta.authMode
  )

  if (!accessCheck.authorized) {
    return accessCheck.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Block guest sessions — guests cannot download files
  if (accessCheck.isGuest) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date()

  // Fetch data in parallel
  const [readyVideos, albums, uploadFolders, uploadFiles, approvableCount] = await Promise.all([
    prisma.video.findMany({
      where: {
        projectId: projectMeta.id,
        status: 'READY',
      },
      include: {
        assets: {
          where: {
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
        },
      },
      orderBy: [{ name: 'asc' }, { version: 'desc' }],
    }),
    prisma.album.findMany({
      where: { projectId: projectMeta.id, status: 'READY' },
      select: {
        id: true,
        name: true,
        fullZipFileSize: true,
        socialZipFileSize: true,
        socialCopiesEnabled: true,
        photos: {
          where: { status: 'READY' },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            socialStatus: true,
            socialStoragePath: true,
            thumbnailStatus: true,
            thumbnailStoragePath: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.$queryRaw<ShareUploadFolderRow[]>`
      SELECT "relativePath"
      FROM "ShareUploadFolder"
      WHERE "projectId" = ${projectMeta.id}
      ORDER BY "relativePath" ASC
    `,
    prisma.$queryRaw<ShareUploadFileRow[]>`
      SELECT "id", "folderRelativePath", "fileName", "fileSize", "fileType", "mediaDurationSeconds", "previewStatus", "timelinePreviewsReady", "timelinePreviewVttPath", "timelinePreviewSpritesPath"
      FROM "ShareUploadFile"
      WHERE "projectId" = ${projectMeta.id}
      ORDER BY "folderRelativePath" ASC, "createdAt" ASC
    `,
    prisma.video.count({
      where: { projectId: projectMeta.id, allowApproval: true },
    }),
  ])
  const uploadGroupsByPath = new Map<string, DownloadableFile[]>()

  const sessionId = accessCheck.shareTokenSessionId || (accessCheck.isAdmin ? `admin:${Date.now()}` : `share:${Date.now()}`)

  for (const folder of uploadFolders) {
    const folderPath = String(folder.relativePath || '').trim()
    if (!uploadGroupsByPath.has(folderPath)) {
      uploadGroupsByPath.set(folderPath, [])
    }
  }

  // Generate timeline tokens for upload files that are videos with sprites
  const uploadTimelineTokens = new Map<string, { vttToken: string; spriteToken: string } | null>()
  await Promise.all(
    uploadFiles.map(async (file) => {
      const isVideo = String(file.fileType || '').toLowerCase().startsWith('video/')
      const hasTimeline = isVideo && !!(file.timelinePreviewVttPath) && !!(file.timelinePreviewSpritesPath)
      if (!hasTimeline) {
        uploadTimelineTokens.set(file.id, null)
        return
      }
      try {
        const [vttToken, spriteToken] = await Promise.all([
          generateVideoAccessToken('upload', projectMeta.id, 'timeline-vtt', request, sessionId, undefined, 'upload', file.id),
          generateVideoAccessToken('upload', projectMeta.id, 'timeline-sprite', request, sessionId, undefined, 'upload', file.id),
        ])
        uploadTimelineTokens.set(file.id, { vttToken, spriteToken })
      } catch {
        uploadTimelineTokens.set(file.id, null)
      }
    })
  )

  for (const file of uploadFiles) {
    const folderPath = String(file.folderRelativePath || '').trim()
    if (!uploadGroupsByPath.has(folderPath)) {
      uploadGroupsByPath.set(folderPath, [])
    }

    const tokens = uploadTimelineTokens.get(file.id)
    const hasTimeline = tokens !== undefined && tokens !== null

    uploadGroupsByPath.get(folderPath)!.push({
      type: 'upload-file',
      uploadFileId: file.id,
      uploadFolderPath: folderPath,
      fileName: file.fileName,
      fileSizeBytes: Number(file.fileSize),
      durationSeconds: String(file.fileType || '').toLowerCase().startsWith('video/')
        ? (typeof file.mediaDurationSeconds === 'number' && Number.isFinite(file.mediaDurationSeconds)
            ? file.mediaDurationSeconds
            : undefined)
        : undefined,
      previewStatus: file.previewStatus ?? undefined,
      hasTimelinePreviews: hasTimeline,
      timelineVttUrl: tokens ? `/api/content/${tokens.vttToken}` : undefined,
      timelineSpriteBaseUrl: tokens ? `/api/content/${tokens.spriteToken}` : undefined,
    })
  }

  // Keep a synthetic root only when uploads are completely empty.
  // If real folders/files exist, do not add an extra empty `UPLOADS` entry.
  if (uploadGroupsByPath.size === 0) {
    uploadGroupsByPath.set('', [])
  }

  const uploadGroups: DownloadableGroup[] = [...uploadGroupsByPath.entries()]
    .map(([folderPath, files]) => ({
      name: folderPath ? `UPLOADS / ${folderPath}` : 'UPLOADS',
      groupType: 'uploads' as const,
      subFiles: files,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))


  // Build video groups: one per unique video name, containing all versions.
  const videosByName = new Map<string, typeof readyVideos>()

  for (const video of readyVideos) {
    if (!videosByName.has(video.name)) {
      videosByName.set(video.name, [])
    }
    videosByName.get(video.name)!.push(video)
  }

  const videoGroups: DownloadableGroup[] = []

  // Generate timeline tokens in parallel for all videos that have sprites
  const videoTimelineTokens = new Map<string, { vttToken: string; spriteToken: string } | null>()
  await Promise.all(
    readyVideos.map(async (video) => {
      const hasTimeline = !!(video as any).timelinePreviewVttPath && !!(video as any).timelinePreviewSpritesPath
      if (!hasTimeline) {
        videoTimelineTokens.set(video.id, null)
        return
      }
      try {
        const [vttToken, spriteToken] = await Promise.all([
          generateVideoAccessToken(video.id, projectMeta.id, 'timeline-vtt', request, sessionId),
          generateVideoAccessToken(video.id, projectMeta.id, 'timeline-sprite', request, sessionId),
        ])
        videoTimelineTokens.set(video.id, { vttToken, spriteToken })
      } catch {
        videoTimelineTokens.set(video.id, null)
      }
    })
  )

  for (const [videoName, videos] of videosByName.entries()) {
    const sortedVersions = [...videos].sort((a, b) => b.version - a.version)
    const versionFiles: DownloadableFile[] = sortedVersions.map((video) => {
      const tokens = videoTimelineTokens.get(video.id)
      const hasTimeline = tokens !== undefined && tokens !== null
      return {
        type: 'video',
        videoId: video.id,
        fileName: video.originalFileName,
        fileSizeBytes: Number(video.originalFileSize),
        durationSeconds: Number(video.duration),
        versionLabel: (video as any).versionLabel ? String((video as any).versionLabel) : undefined,
        isApproved: video.approved === true,
        allowApproval: video.allowApproval === true,
        hasTimelinePreviews: hasTimeline,
        timelineVttUrl: tokens ? `/api/content/${tokens.vttToken}` : undefined,
        timelineSpriteBaseUrl: tokens ? `/api/content/${tokens.spriteToken}` : undefined,
      }
    })

    const approvedVideo = sortedVersions.find((video) => video.approved === true)

    // Generate timeline tokens for video assets that are videos with sprites
    const assetTimelineTokens = new Map<string, { vttToken: string; spriteToken: string } | null>()
    if (approvedVideo) {
      await Promise.all(
        approvedVideo.assets.map(async (asset: any) => {
          const isVideo = String(asset.fileType || '').toLowerCase().startsWith('video/')
          const hasTimeline = isVideo && !!(asset.timelinePreviewVttPath) && !!(asset.timelinePreviewSpritesPath)
          if (!hasTimeline) {
            assetTimelineTokens.set(asset.id, null)
            return
          }
          try {
            const [vttToken, spriteToken] = await Promise.all([
              generateVideoAccessToken(approvedVideo.id, projectMeta.id, 'timeline-vtt', request, sessionId, undefined, 'asset', asset.id),
              generateVideoAccessToken(approvedVideo.id, projectMeta.id, 'timeline-sprite', request, sessionId, undefined, 'asset', asset.id),
            ])
            assetTimelineTokens.set(asset.id, { vttToken, spriteToken })
          } catch {
            assetTimelineTokens.set(asset.id, null)
          }
        })
      )
    }

    const assetFiles: DownloadableFile[] = approvedVideo
      ? approvedVideo.assets.map((asset: any): DownloadableFile => {
          const tokens = assetTimelineTokens.get(asset.id)
          const hasTimeline = tokens !== undefined && tokens !== null
          return {
            type: 'asset',
            videoId: approvedVideo.id,
            assetId: asset.id,
            fileName: asset.fileName,
            fileSizeBytes: Number(asset.fileSize),
            durationSeconds: typeof asset.mediaDurationSeconds === 'number' ? asset.mediaDurationSeconds : undefined,
            hasTimelinePreviews: hasTimeline,
            timelineVttUrl: tokens ? `/api/content/${tokens.vttToken}` : undefined,
            timelineSpriteBaseUrl: tokens ? `/api/content/${tokens.spriteToken}` : undefined,
          }
        })
      : []

    videoGroups.push({
      name: videoName,
      groupType: 'video',
      mainFile: versionFiles[0],
      subFiles: [...versionFiles.slice(1), ...assetFiles],
    })
  }

  // Sort video groups alphabetically by name
  videoGroups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  // Build album groups: only include albums with at least one ready zip
  const albumGroups: DownloadableGroup[] = []
  const albumsNeedingThumbnailBackfill = new Set<string>()

  for (const album of albums) {
    const zips: DownloadableFile[] = []

    if ((album.fullZipFileSize ?? BigInt(0)) > BigInt(0)) {
      zips.push({
        type: 'album-zip',
        albumId: album.id,
        variant: 'full',
        fileName: getAlbumZipFileName({ albumName: album.name, variant: 'full' }),
        fileSizeBytes: Number(album.fullZipFileSize),
      })
    }

    if (album.socialCopiesEnabled && (album.socialZipFileSize ?? BigInt(0)) > BigInt(0)) {
      zips.push({
        type: 'album-zip',
        albumId: album.id,
        variant: 'social',
        fileName: getAlbumZipFileName({ albumName: album.name, variant: 'social' }),
        fileSizeBytes: Number(album.socialZipFileSize),
      })
    }

    const photos: DownloadableFile[] = await Promise.all(
      album.photos.map(async (photo: any) => {
        const tokenValue = await generateAlbumPhotoAccessToken({
          photoId: photo.id,
          albumId: album.id,
          projectId: projectMeta.id,
          request,
          sessionId,
        })

        if (photo.thumbnailStatus !== 'READY' || !photo.thumbnailStoragePath) {
          albumsNeedingThumbnailBackfill.add(album.id)
        }

        return {
          type: 'album-photo',
          albumId: album.id,
          photoId: photo.id,
          fileName: photo.fileName,
          fileSizeBytes: asNumberBigInt(photo.fileSize),
          thumbnailUrl: `/api/content/photo/${tokenValue}?variant=thumbnail`,
          previewUrl: `/api/content/photo/${tokenValue}?variant=preview`,
          downloadUrl: `/api/content/photo/${tokenValue}?download=true`,
        } as DownloadableFile
      })
    )

    if (zips.length > 0 || photos.length > 0) {
      albumGroups.push({
        name: album.name,
        groupType: 'album',
        subFiles: [...zips, ...photos],
      })
    }
  }

  if (albumsNeedingThumbnailBackfill.size > 0) {
    await Promise.allSettled(
      [...albumsNeedingThumbnailBackfill].map((albumId) => enqueueAlbumThumbnailJob({ albumId, delayMs: 500 }))
    )
  }

  // If client uploads are disabled for clients, omit UPLOADS groups for non-admin sessions.
  const showUploads = accessCheck.isAdmin || (projectMeta.enableClientUploads !== false)
  const result: DownloadableFilesResult = {
    groups: [...videoGroups, ...albumGroups, ...(showUploads ? uploadGroups : [])],
    hasApprovableVideos: approvableCount > 0,
  }

  return NextResponse.json(result)
}
