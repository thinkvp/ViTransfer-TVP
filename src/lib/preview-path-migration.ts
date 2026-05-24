import { prisma } from '@/lib/db'
import {
  buildAlbumPhotoThumbnailStoragePath,
  buildProjectStorageRoot,
  buildProjectUploadVideoThumbnailStoragePath,
  buildVideoAssetPreviewStoragePath,
  buildVideoPreviewStoragePath,
  buildVideoThumbnailStoragePath,
  buildVideoTimelineStorageRoot,
} from '@/lib/project-storage-paths'
import { moveDirectory, moveFile } from '@/lib/storage'

type PreviewPathMigrationSample = {
  entity: 'video' | 'albumPhoto' | 'shareUploadFile' | 'videoAsset'
  id: string
  field: string
  from: string
  to: string
}

export type PreviewPathMigrationResult = {
  ok: true
  dryRun: boolean
  scannedVideos: number
  scannedAlbumPhotos: number
  scannedShareUploadFiles: number
  scannedVideoAssets: number
  updatedRecords: number
  updatedFields: number
  sample: PreviewPathMigrationSample[]
  sampleTruncated: boolean
  errors?: Array<{ entity: string; id: string; error: string }>
}

type ProjectPathInfo = {
  storagePath: string | null
  title: string
  companyName: string | null
  client?: { name: string | null } | null
}

function resolveProjectStoragePath(project: ProjectPathInfo): string {
  return project.storagePath || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)
}

function hasCustomVideoThumbnail(thumbnailPath: string | null | undefined): boolean {
  return Boolean(thumbnailPath && thumbnailPath.includes('/videos/assets/'))
}

function resolveVideoAssetPreviewExtension(fileType: string | null | undefined): '.jpg' | '.mp4' {
  const normalized = String(fileType || '').toLowerCase()
  return normalized.startsWith('video/') ? '.mp4' : '.jpg'
}

function pushSample(
  sample: PreviewPathMigrationSample[],
  sampleTruncated: boolean,
  entry: PreviewPathMigrationSample,
): { sample: PreviewPathMigrationSample[]; sampleTruncated: boolean } {
  if (sample.length < 50) {
    sample.push(entry)
    return { sample, sampleTruncated }
  }
  return { sample, sampleTruncated: true }
}

async function moveBestEffort(sourcePath: string | null | undefined, destinationPath: string | null | undefined): Promise<void> {
  if (!sourcePath || !destinationPath || sourcePath === destinationPath) return
  await moveFile(sourcePath, destinationPath).catch(() => {})
}

async function moveDirectoryBestEffort(sourcePath: string | null | undefined, destinationPath: string | null | undefined): Promise<void> {
  if (!sourcePath || !destinationPath || sourcePath === destinationPath) return
  await moveDirectory(sourcePath, destinationPath).catch(() => {})
}

export async function migratePreviewPaths(dryRun: boolean): Promise<PreviewPathMigrationResult> {
  const [videos, albumPhotos, shareUploadFiles, videoAssets] = await Promise.all([
    prisma.video.findMany({
      select: {
        id: true,
        name: true,
        storageFolderName: true,
        versionLabel: true,
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
    prisma.albumPhoto.findMany({
      select: {
        id: true,
        storagePath: true,
        thumbnailStoragePath: true,
        album: {
          select: {
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
        },
      },
    }),
    prisma.shareUploadFile.findMany({
      select: {
        id: true,
        storagePath: true,
        previewPath: true,
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
        id: true,
        storagePath: true,
        fileType: true,
        previewPath: true,
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
  ])

  let sample: PreviewPathMigrationSample[] = []
  let sampleTruncated = false
  let updatedRecords = 0
  let updatedFields = 0
  const errors: Array<{ entity: string; id: string; error: string }> = []

  for (const video of videos) {
    const projectStoragePath = resolveProjectStoragePath(video.project)
    const videoFolderName = video.storageFolderName || video.name
    if (!videoFolderName || !video.versionLabel) continue

    const updates: Record<string, string> = {}
    const desiredPreview480Path = video.preview480Path ? buildVideoPreviewStoragePath(projectStoragePath, videoFolderName, video.versionLabel, '480p') : null
    const desiredPreview720Path = video.preview720Path ? buildVideoPreviewStoragePath(projectStoragePath, videoFolderName, video.versionLabel, '720p') : null
    const desiredPreview1080Path = video.preview1080Path ? buildVideoPreviewStoragePath(projectStoragePath, videoFolderName, video.versionLabel, '1080p') : null
    const desiredThumbnailPath = !hasCustomVideoThumbnail(video.thumbnailPath)
      && video.thumbnailPath
      ? buildVideoThumbnailStoragePath(projectStoragePath, videoFolderName, video.versionLabel)
      : null
    const desiredTimelineVttPath = video.timelinePreviewVttPath
      ? `${buildVideoTimelineStorageRoot(projectStoragePath, videoFolderName, video.versionLabel)}/index.vtt`
      : null
    const desiredTimelineSpritesPath = video.timelinePreviewSpritesPath
      ? buildVideoTimelineStorageRoot(projectStoragePath, videoFolderName, video.versionLabel)
      : null

    if (video.preview480Path && desiredPreview480Path && video.preview480Path !== desiredPreview480Path) {
      await moveBestEffort(video.preview480Path, desiredPreview480Path)
      updates.preview480Path = desiredPreview480Path
      updatedFields++
      ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, { entity: 'video', id: video.id, field: 'preview480Path', from: video.preview480Path, to: desiredPreview480Path }))
    }
    if (video.preview720Path && desiredPreview720Path && video.preview720Path !== desiredPreview720Path) {
      await moveBestEffort(video.preview720Path, desiredPreview720Path)
      updates.preview720Path = desiredPreview720Path
      updatedFields++
      ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, { entity: 'video', id: video.id, field: 'preview720Path', from: video.preview720Path, to: desiredPreview720Path }))
    }
    if (video.preview1080Path && desiredPreview1080Path && video.preview1080Path !== desiredPreview1080Path) {
      await moveBestEffort(video.preview1080Path, desiredPreview1080Path)
      updates.preview1080Path = desiredPreview1080Path
      updatedFields++
      ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, { entity: 'video', id: video.id, field: 'preview1080Path', from: video.preview1080Path, to: desiredPreview1080Path }))
    }
    if (video.thumbnailPath && desiredThumbnailPath && video.thumbnailPath !== desiredThumbnailPath) {
      await moveBestEffort(video.thumbnailPath, desiredThumbnailPath)
      updates.thumbnailPath = desiredThumbnailPath
      updatedFields++
      ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, { entity: 'video', id: video.id, field: 'thumbnailPath', from: video.thumbnailPath, to: desiredThumbnailPath }))
    }
    if (video.timelinePreviewVttPath && desiredTimelineVttPath && video.timelinePreviewVttPath !== desiredTimelineVttPath) {
      await moveBestEffort(video.timelinePreviewVttPath, desiredTimelineVttPath)
      updates.timelinePreviewVttPath = desiredTimelineVttPath
      updatedFields++
      ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, { entity: 'video', id: video.id, field: 'timelinePreviewVttPath', from: video.timelinePreviewVttPath, to: desiredTimelineVttPath }))
    }
    if (video.timelinePreviewSpritesPath && desiredTimelineSpritesPath && video.timelinePreviewSpritesPath !== desiredTimelineSpritesPath) {
      await moveDirectoryBestEffort(video.timelinePreviewSpritesPath, desiredTimelineSpritesPath)
      updates.timelinePreviewSpritesPath = desiredTimelineSpritesPath
      updatedFields++
      ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, { entity: 'video', id: video.id, field: 'timelinePreviewSpritesPath', from: video.timelinePreviewSpritesPath, to: desiredTimelineSpritesPath }))
    }

    if (Object.keys(updates).length === 0) continue
    updatedRecords++
    if (!dryRun) {
      try {
        await prisma.video.update({ where: { id: video.id }, data: updates })
      } catch (error) {
        errors.push({ entity: 'video', id: video.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  for (const photo of albumPhotos) {
    if (!photo.thumbnailStoragePath) continue
    const projectStoragePath = resolveProjectStoragePath(photo.album.project)
    const desiredThumbnailPath = buildAlbumPhotoThumbnailStoragePath(projectStoragePath, photo.storagePath)
    if (photo.thumbnailStoragePath === desiredThumbnailPath) continue

    await moveBestEffort(photo.thumbnailStoragePath, desiredThumbnailPath)

    updatedRecords++
    updatedFields++
    ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, {
      entity: 'albumPhoto',
      id: photo.id,
      field: 'thumbnailStoragePath',
      from: photo.thumbnailStoragePath,
      to: desiredThumbnailPath,
    }))

    if (!dryRun) {
      try {
        await prisma.albumPhoto.update({ where: { id: photo.id }, data: { thumbnailStoragePath: desiredThumbnailPath } })
      } catch (error) {
        errors.push({ entity: 'albumPhoto', id: photo.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  for (const file of shareUploadFiles) {
    if (!file.previewPath) continue
    const projectStoragePath = resolveProjectStoragePath(file.project)
    const desiredPreviewPath = buildProjectUploadVideoThumbnailStoragePath(projectStoragePath, file.storagePath)
    if (file.previewPath === desiredPreviewPath) continue

    await moveBestEffort(file.previewPath, desiredPreviewPath)

    updatedRecords++
    updatedFields++
    ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, {
      entity: 'shareUploadFile',
      id: file.id,
      field: 'previewPath',
      from: file.previewPath,
      to: desiredPreviewPath,
    }))

    if (!dryRun) {
      try {
        await prisma.shareUploadFile.update({ where: { id: file.id }, data: { previewPath: desiredPreviewPath } })
      } catch (error) {
        errors.push({ entity: 'shareUploadFile', id: file.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  for (const asset of videoAssets) {
    if (!asset.previewPath) continue
    const projectStoragePath = resolveProjectStoragePath(asset.video.project)
    const previewExtension = resolveVideoAssetPreviewExtension(asset.fileType)
    const desiredPreviewPath = buildVideoAssetPreviewStoragePath(
      projectStoragePath,
      asset.video.storageFolderName || asset.video.name,
      asset.video.versionLabel,
      asset.storagePath,
      previewExtension,
    )
    if (asset.previewPath === desiredPreviewPath) continue

    await moveBestEffort(asset.previewPath, desiredPreviewPath)

    updatedRecords++
    updatedFields++
    ;({ sample, sampleTruncated } = pushSample(sample, sampleTruncated, {
      entity: 'videoAsset',
      id: asset.id,
      field: 'previewPath',
      from: asset.previewPath,
      to: desiredPreviewPath,
    }))

    if (!dryRun) {
      try {
        await prisma.videoAsset.update({ where: { id: asset.id }, data: { previewPath: desiredPreviewPath } })
      } catch (error) {
        errors.push({ entity: 'videoAsset', id: asset.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  return {
    ok: true,
    dryRun,
    scannedVideos: videos.length,
    scannedAlbumPhotos: albumPhotos.length,
    scannedShareUploadFiles: shareUploadFiles.length,
    scannedVideoAssets: videoAssets.length,
    updatedRecords,
    updatedFields,
    sample,
    sampleTruncated,
    ...(errors.length ? { errors: errors.slice(0, 50) } : {}),
  }
}