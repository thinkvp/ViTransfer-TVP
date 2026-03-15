import { prisma } from '@/lib/db'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { storagePathExistsLocal, resolveVideoOriginalPath } from '@/lib/resolve-video-original'
import { dropboxPathExists, isDropboxStorageConfigured, stripDropboxStoragePrefix } from '@/lib/storage-provider-dropbox'
import {
  clearDropboxStorageInconsistencyNotifications,
  upsertDropboxStorageInconsistencyNotification,
} from '@/lib/dropbox-storage-inconsistency-log'

type DropboxInconsistencyReason = 'DROPBOX_PATH_MISSING' | 'DROPBOX_FILE_MISSING'
type DropboxEntityType = 'video' | 'asset' | 'album-zip'

export type DropboxStorageInconsistency = {
  entityType: DropboxEntityType
  entityId: string
  label: string
  projectId: string
  projectTitle: string
  localPath: string | null
  localExists: boolean
  dropboxPath: string | null
  uploadStatus: string | null
  reason: DropboxInconsistencyReason
}

export type DropboxStorageConsistencyScanResult = {
  scannedAt: string
  checkedCount: number
  inconsistencyCount: number
  inconsistencies: DropboxStorageInconsistency[]
  skippedReason: string | null
  report: string
}

type VideoCandidate = {
  entityType: 'video'
  entityId: string
  label: string
  projectId: string
  projectTitle: string
  localPath: string | null
  dropboxPath: string | null
  uploadStatus: string | null
}

type AssetCandidate = {
  entityType: 'asset'
  entityId: string
  label: string
  projectId: string
  projectTitle: string
  localPath: string | null
  dropboxPath: string | null
  uploadStatus: string | null
}

type AlbumCandidate = {
  entityType: 'album-zip'
  entityId: string
  label: string
  projectId: string
  projectTitle: string
  localPath: string | null
  dropboxPath: string | null
  uploadStatus: string | null
}

type Candidate = VideoCandidate | AssetCandidate | AlbumCandidate

const DROPBOX_SCAN_CONCURRENCY = 8

function shouldExpectDropboxFile(uploadStatus: string | null | undefined): boolean {
  return uploadStatus !== 'PENDING' && uploadStatus !== 'UPLOADING'
}

function normalizeLocalPath(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null
  return storagePath.startsWith('dropbox:') ? stripDropboxStoragePrefix(storagePath) : storagePath
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) return []

  const results = new Array<TResult>(items.length)
  let nextIndex = 0

  async function worker() {
    while (true) {
      const currentIndex = nextIndex
      nextIndex += 1
      if (currentIndex >= items.length) return
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )

  return results
}

function formatInconsistencyLine(entry: DropboxStorageInconsistency): string {
  const scope = `[${entry.entityType}] ${entry.projectTitle} :: ${entry.label}`
  const pathPart = entry.dropboxPath
    ? `Dropbox path "${entry.dropboxPath}"`
    : 'Dropbox path is missing in the database'
  const statusPart = entry.uploadStatus ? `status=${entry.uploadStatus}` : 'status=unset'

  if (entry.reason === 'DROPBOX_PATH_MISSING') {
    return `${scope} - ${pathPart} (${statusPart}, local=${entry.localExists ? 'present' : 'missing'})`
  }

  return `${scope} - ${pathPart} not found on Dropbox (${statusPart}, local=${entry.localExists ? 'present' : 'missing'})`
}

function buildScanReport(result: Omit<DropboxStorageConsistencyScanResult, 'report'>): string {
  if (result.skippedReason) {
    return result.skippedReason
  }

  const header = [
    `Scanned at: ${new Date(result.scannedAt).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`,
    `Checked Dropbox-backed items: ${result.checkedCount}`,
    `Inconsistencies found: ${result.inconsistencyCount}`,
  ]

  if (result.inconsistencyCount === 0) {
    return [...header, '', 'No inconsistencies found.'].join('\n')
  }

  const lines = result.inconsistencies.map((entry, index) => `${index + 1}. ${formatInconsistencyLine(entry)}`)
  return [...header, '', ...lines].join('\n')
}

async function buildCandidates(): Promise<Candidate[]> {
  const [videos, assets, albums] = await Promise.all([
    prisma.video.findMany({
      where: { dropboxEnabled: true },
      select: {
        id: true,
        name: true,
        versionLabel: true,
        originalFileName: true,
        originalStoragePath: true,
        storageFolderName: true,
        dropboxPath: true,
        dropboxUploadStatus: true,
        projectId: true,
        project: {
          select: {
            title: true,
            storagePath: true,
            companyName: true,
            client: { select: { name: true } },
          },
        },
      },
    }),
    prisma.videoAsset.findMany({
      where: { dropboxEnabled: true },
      select: {
        id: true,
        fileName: true,
        storagePath: true,
        dropboxPath: true,
        dropboxUploadStatus: true,
        video: {
          select: {
            id: true,
            name: true,
            versionLabel: true,
            projectId: true,
            project: {
              select: {
                title: true,
              },
            },
          },
        },
      },
    }),
    prisma.album.findMany({
      where: { dropboxEnabled: true },
      select: {
        id: true,
        name: true,
        storageFolderName: true,
        fullZipDropboxPath: true,
        fullZipDropboxStatus: true,
        socialZipDropboxPath: true,
        socialZipDropboxStatus: true,
        projectId: true,
        project: {
          select: {
            title: true,
            storagePath: true,
          },
        },
      },
    }),
  ])

  const videoCandidates: Candidate[] = videos.map((video) => ({
    entityType: 'video',
    entityId: video.id,
    label: `${video.name} ${video.versionLabel}`,
    projectId: video.projectId,
    projectTitle: video.project.title,
    localPath: resolveVideoOriginalPath({
      id: video.id,
      name: video.name,
      versionLabel: video.versionLabel,
      originalFileName: video.originalFileName,
      originalStoragePath: video.originalStoragePath,
      storageFolderName: video.storageFolderName,
      projectId: video.projectId,
      project: {
        title: video.project.title,
        companyName: video.project.companyName,
        storagePath: video.project.storagePath,
        client: video.project.client,
      },
    }) ?? normalizeLocalPath(video.originalStoragePath),
    dropboxPath: video.dropboxPath,
    uploadStatus: video.dropboxUploadStatus,
  }))

  const assetCandidates: Candidate[] = assets.map((asset) => ({
    entityType: 'asset',
    entityId: asset.id,
    label: `${asset.video.name} ${asset.video.versionLabel} / ${asset.fileName}`,
    projectId: asset.video.projectId,
    projectTitle: asset.video.project.title,
    localPath: normalizeLocalPath(asset.storagePath),
    dropboxPath: asset.dropboxPath,
    uploadStatus: asset.dropboxUploadStatus,
  }))

  const albumCandidates: Candidate[] = albums.flatMap((album) => {
    const items: Candidate[] = []

    if (album.fullZipDropboxPath || album.fullZipDropboxStatus) {
      items.push({
        entityType: 'album-zip',
        entityId: `${album.id}:full`,
        label: `${album.name} / Full ZIP`,
        projectId: album.projectId,
        projectTitle: album.project.title,
        localPath: getAlbumZipStoragePath({
          projectId: album.projectId,
          albumId: album.id,
          projectStoragePath: album.project.storagePath ?? undefined,
          albumFolderName: album.storageFolderName ?? undefined,
          albumName: album.name,
          variant: 'full',
        }),
        dropboxPath: album.fullZipDropboxPath,
        uploadStatus: album.fullZipDropboxStatus,
      })
    }

    if (album.socialZipDropboxPath || album.socialZipDropboxStatus) {
      items.push({
        entityType: 'album-zip',
        entityId: `${album.id}:social`,
        label: `${album.name} / Social ZIP`,
        projectId: album.projectId,
        projectTitle: album.project.title,
        localPath: getAlbumZipStoragePath({
          projectId: album.projectId,
          albumId: album.id,
          projectStoragePath: album.project.storagePath ?? undefined,
          albumFolderName: album.storageFolderName ?? undefined,
          albumName: album.name,
          variant: 'social',
        }),
        dropboxPath: album.socialZipDropboxPath,
        uploadStatus: album.socialZipDropboxStatus,
      })
    }

    return items
  })

  return [...videoCandidates, ...assetCandidates, ...albumCandidates]
}

async function inspectCandidate(candidate: Candidate): Promise<DropboxStorageInconsistency | null> {
  if (!shouldExpectDropboxFile(candidate.uploadStatus)) {
    return null
  }

  const localExists = storagePathExistsLocal(candidate.localPath)

  if (!candidate.dropboxPath) {
    return {
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      label: candidate.label,
      projectId: candidate.projectId,
      projectTitle: candidate.projectTitle,
      localPath: candidate.localPath,
      localExists,
      dropboxPath: null,
      uploadStatus: candidate.uploadStatus,
      reason: 'DROPBOX_PATH_MISSING',
    }
  }

  const existsOnDropbox = await dropboxPathExists(candidate.dropboxPath)
  if (existsOnDropbox) {
    return null
  }

  return {
    entityType: candidate.entityType,
    entityId: candidate.entityId,
    label: candidate.label,
    projectId: candidate.projectId,
    projectTitle: candidate.projectTitle,
    localPath: candidate.localPath,
    localExists,
    dropboxPath: candidate.dropboxPath,
    uploadStatus: candidate.uploadStatus,
    reason: 'DROPBOX_FILE_MISSING',
  }
}

export async function runDropboxStorageConsistencyScan(): Promise<DropboxStorageConsistencyScanResult> {
  const scannedAt = new Date().toISOString()

  if (!isDropboxStorageConfigured()) {
    const resultWithoutReport = {
      scannedAt,
      checkedCount: 0,
      inconsistencyCount: 0,
      inconsistencies: [],
      skippedReason: 'Dropbox storage is not configured.',
    }
    return {
      ...resultWithoutReport,
      report: buildScanReport(resultWithoutReport),
    }
  }

  const candidates = await buildCandidates()
  const inspectionResults = await mapWithConcurrency(candidates, DROPBOX_SCAN_CONCURRENCY, inspectCandidate)
  const inconsistencies = inspectionResults.filter((entry): entry is DropboxStorageInconsistency => entry !== null)

  const resultWithoutReport = {
    scannedAt,
    checkedCount: candidates.length,
    inconsistencyCount: inconsistencies.length,
    inconsistencies,
    skippedReason: null,
  }

  return {
    ...resultWithoutReport,
    report: buildScanReport(resultWithoutReport),
  }
}

export async function runDropboxStorageConsistencyScanAndSyncNotification(): Promise<DropboxStorageConsistencyScanResult> {
  const result = await runDropboxStorageConsistencyScan()

  if (result.skippedReason || result.inconsistencyCount === 0) {
    await clearDropboxStorageInconsistencyNotifications()
    return result
  }

  await upsertDropboxStorageInconsistencyNotification({
    scannedAtIso: result.scannedAt,
    checkedCount: result.checkedCount,
    inconsistencyCount: result.inconsistencyCount,
    report: result.report,
    entities: result.inconsistencies.map((entry) => ({
      entityType: entry.entityType,
      entityId: entry.entityId,
      projectId: entry.projectId,
    })),
  })

  return result
}