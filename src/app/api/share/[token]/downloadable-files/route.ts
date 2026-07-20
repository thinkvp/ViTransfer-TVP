import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { getAlbumZipFileName } from '@/lib/album-photo-zip'
import { generateAlbumPhotoAccessToken } from '@/lib/photo-access'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import { generateVideoAccessToken } from '@/lib/video-access'
import { batchResolveFileSizes, getStoredFileRecords, storedFileExists } from '@/lib/stored-file'
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
  fileType: string
  mediaDurationSeconds: number | null
  previewStatus: string | null
  timelinePreviewsReady: boolean | null
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
    select: { id: true, sharePassword: true, authMode: true, enableUploads: true, enableClientUploads: true },
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
        socialCopiesEnabled: true,
        photos: {
          where: { status: 'READY' },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            fileName: true,
            socialStatus: true,
            thumbnailStatus: true,
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
      SELECT "id", "folderRelativePath", "fileName", "fileType", "mediaDurationSeconds", "previewStatus", "timelinePreviewsReady"
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

  // Resolve upload file sizes from StoredFile (with S3 fallback for null sizes)
  const uploadFileIds = uploadFiles.map((f) => f.id)
  const uploadSizeMap = await batchResolveFileSizes('SHARE_UPLOAD_FILE', uploadFileIds)

  // Generate timeline tokens for upload files that are videos with sprites
  const uploadTimelineTokens = new Map<string, { vttToken: string; spriteToken: string } | null>()
  await Promise.all(
    uploadFiles.map(async (file) => {
      const isVideo = String(file.fileType || '').toLowerCase().startsWith('video/')
      const hasTimeline = isVideo && file.timelinePreviewsReady === true
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
      fileSizeBytes: uploadSizeMap.get(file.id) ?? 0,
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

  // Resolve timeline availability from StoredFile for all videos
  const videoIds = readyVideos.map(v => v.id)
  const videoStoredFiles = videoIds.length > 0 ? await getStoredFileRecords('VIDEO', videoIds, { fileRoles: ['TIMELINE_VTT', 'TIMELINE_SPRITES', 'ORIGINAL'], select: { entityId: true, fileRole: true, fileSize: true, fileName: true, storagePath: true } }) : []
  const videoNameMap = new Map<string, string>()
  const videoTimelineStored: Record<string, any>[] = []
  for (const s of videoStoredFiles) {
    if (s.fileRole === 'ORIGINAL') {
      if (s.fileName) videoNameMap.set(s.entityId, s.fileName)
    } else {
      videoTimelineStored.push(s)
    }
  }
  // Batch-resolve video sizes with S3 fallback
  const videoSizeMap = await batchResolveFileSizes('VIDEO', videoIds)
  const videoHasTimeline = new Set<string>()
  for (const s of videoTimelineStored) {
    if (s.fileRole === 'TIMELINE_VTT') {
      // Only mark as having timeline if BOTH VTT and SPRITES exist (check SPRITES below)
      const hasSprites = videoTimelineStored.some(x => x.entityId === s.entityId && x.fileRole === 'TIMELINE_SPRITES')
      if (hasSprites) videoHasTimeline.add(s.entityId)
    }
  }

  // Generate timeline tokens in parallel for all videos that have sprites
  const videoTimelineTokens = new Map<string, { vttToken: string; spriteToken: string } | null>()
  await Promise.all(
    readyVideos.map(async (video) => {
      if (!videoHasTimeline.has(video.id)) {
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
        fileName: videoNameMap.get(video.id) || video.name,
        fileSizeBytes: videoSizeMap.get(video.id) ?? 0,
        durationSeconds: Number(video.duration),
        versionLabel: (video as any).versionLabel ? String((video as any).versionLabel) : undefined,
        isApproved: video.approved === true,
        allowApproval: video.allowApproval === true,
        isRevisionRequested: (video as any).revisionRequestedAt != null,
        hasTimelinePreviews: hasTimeline,
        timelineVttUrl: tokens ? `/api/content/${tokens.vttToken}` : undefined,
        timelineSpriteBaseUrl: tokens ? `/api/content/${tokens.spriteToken}` : undefined,
      }
    })

    const approvedVideo = sortedVersions.find((video) => video.approved === true)

    // Generate timeline tokens for video assets that are videos with sprites
    const assetTimelineTokens = new Map<string, { vttToken: string; spriteToken: string } | null>()
    if (approvedVideo && approvedVideo.assets.length > 0) {
      // Resolve asset timeline availability from StoredFile
      const assetIds = approvedVideo.assets.map((a: any) => a.id)
      const assetTimelineStored = await getStoredFileRecords('VIDEO_ASSET', assetIds, { fileRoles: ['TIMELINE_VTT', 'TIMELINE_SPRITES'], select: { entityId: true, fileRole: true } })
      const assetHasTimeline = new Set<string>()
      for (const s of assetTimelineStored) {
        if (s.fileRole === 'TIMELINE_VTT') {
          const hasSprites = assetTimelineStored.some(x => x.entityId === s.entityId && x.fileRole === 'TIMELINE_SPRITES')
          if (hasSprites) assetHasTimeline.add(s.entityId)
        }
      }

      await Promise.all(
        approvedVideo.assets.map(async (asset: any) => {
          const isVideo = String(asset.fileType || '').toLowerCase().startsWith('video/')
          if (!isVideo || !assetHasTimeline.has(asset.id)) {
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

    // Resolve asset file sizes from StoredFile (legacy fileSize column dropped)
    const assetIds = approvedVideo?.assets?.map((a: any) => a.id) ?? []
    const assetSizeMap = await batchResolveFileSizes('VIDEO_ASSET', assetIds)

    // Resolve which video assets still have a playable preview (PREVIEW_MP4). When a
    // project is closed the playback preview can be purged while the still image is
    // kept; the lightbox uses this to show the image instead of an empty player.
    const assetPlaybackPreview = assetIds.length > 0
      ? await getStoredFileRecords('VIDEO_ASSET', assetIds, { fileRoles: ['PREVIEW_MP4'], select: { entityId: true } })
      : []
    const assetHasPlaybackPreview = new Set(assetPlaybackPreview.map(s => s.entityId))

    const assetFiles: DownloadableFile[] = approvedVideo
      ? approvedVideo.assets.map((asset: any): DownloadableFile => {
          const tokens = assetTimelineTokens.get(asset.id)
          const hasTimeline = tokens !== undefined && tokens !== null
          const isVideoAsset = String(asset.fileType || '').toLowerCase().startsWith('video/')
          return {
            type: 'asset',
            videoId: approvedVideo.id,
            assetId: asset.id,
            fileName: asset.fileName,
            fileSizeBytes: assetSizeMap.get(asset.id) ?? 0,
            durationSeconds: typeof asset.mediaDurationSeconds === 'number' ? asset.mediaDurationSeconds : undefined,
            hasTimelinePreviews: hasTimeline,
            timelineVttUrl: tokens ? `/api/content/${tokens.vttToken}` : undefined,
            timelineSpriteBaseUrl: tokens ? `/api/content/${tokens.spriteToken}` : undefined,
            // Only meaningful for playable (video) assets; gates the lightbox player.
            playbackPreviewAvailable: isVideoAsset
              ? (asset.previewStatus === 'READY' && assetHasPlaybackPreview.has(asset.id))
              : undefined,
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

    // ZIP sizes from StoredFile
    const zipStored = await getStoredFileRecords('ALBUM', [album.id], { fileRoles: ['ZIP_FULL', 'ZIP_SOCIAL'], select: { fileRole: true, fileSize: true } })
    const fullZipSize = zipStored.find(z => z.fileRole === 'ZIP_FULL')?.fileSize
    const socialZipSize = zipStored.find(z => z.fileRole === 'ZIP_SOCIAL')?.fileSize

    if ((fullZipSize ?? BigInt(0)) > BigInt(0)) {
      zips.push({
        type: 'album-zip',
        albumId: album.id,
        variant: 'full',
        fileName: getAlbumZipFileName({ albumName: album.name, variant: 'full' }),
        fileSizeBytes: Number(fullZipSize),
      })
    }

    if (album.socialCopiesEnabled && (socialZipSize ?? BigInt(0)) > BigInt(0)) {
      zips.push({
        type: 'album-zip',
        albumId: album.id,
        variant: 'social',
        fileName: getAlbumZipFileName({ albumName: album.name, variant: 'social' }),
        fileSizeBytes: Number(socialZipSize),
      })
    }

    // Resolve photo file sizes from StoredFile (legacy fileSize column dropped)
    const photoIds = album.photos.map((p: any) => p.id)
    const photoSizeMap = await batchResolveFileSizes('ALBUM_PHOTO', photoIds)

    const photos: DownloadableFile[] = await Promise.all(
      album.photos.map(async (photo: any) => {
        const tokenValue = await generateAlbumPhotoAccessToken({
          photoId: photo.id,
          albumId: album.id,
          projectId: projectMeta.id,
          request,
          sessionId,
        })

        // Legacy thumbnailStoragePath column dropped — check StoredFile for THUMBNAIL role
        if (photo.thumbnailStatus !== 'READY' ||
            !(await storedFileExists('ALBUM_PHOTO', photo.id, 'THUMBNAIL'))) {
          albumsNeedingThumbnailBackfill.add(album.id)
        }

        return {
          type: 'album-photo',
          albumId: album.id,
          photoId: photo.id,
          fileName: photo.fileName,
          fileSizeBytes: photoSizeMap.get(photo.id) ?? 0,
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

  // The Uploads project type is the master switch: when off, the UPLOADS folder is
  // hidden from everyone (admins included). When on, clients only see it if client
  // uploads are enabled for the project; admins always see it.
  const showUploads = projectMeta.enableUploads !== false &&
    (accessCheck.isAdmin || projectMeta.enableClientUploads !== false)
  const result: DownloadableFilesResult = {
    groups: [...videoGroups, ...albumGroups, ...(showUploads ? uploadGroups : [])],
    hasApprovableVideos: approvableCount > 0,
  }

  return NextResponse.json(result)
}
