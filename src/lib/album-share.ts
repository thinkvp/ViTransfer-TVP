import { NextRequest } from 'next/server'
import { generateAlbumPhotoAccessToken, presignAlbumPhotoThumbnailUrls } from '@/lib/photo-access'
import { presignAlbumPhotoPreviewUrls } from '@/lib/photo-preview-presign'
import { albumZipExists, getAlbumZipJobId, getAlbumZipStoragePath, type AlbumZipVariant } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'

/**
 * Shared album payload + ZIP helpers for the client-facing album views: the share page
 * (`/api/share/[token]/albums/[albumId]…`) and guest album links (`/api/guest-album-links/[token]…`).
 *
 * Keeping both views on one implementation matters for CrowdSec: every URL a viewer can page
 * through (grid thumbnails, lightbox previews) must be presigned straight to the bucket in S3
 * mode, or a large album bans the viewer's own IP (see photo-preview-presign.ts).
 */

export interface AlbumZipSource {
  id: string
  name: string
  storageFolderName: string | null
  socialCopiesEnabled: boolean
  project: {
    storagePath: string | null
    title: string
    companyName: string | null
    client: { name: string } | null
  }
}

/** Prisma `select` that loads everything {@link AlbumZipSource} needs. */
export const ALBUM_ZIP_SOURCE_SELECT = {
  id: true,
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
} as const

export function getAlbumZipPath(album: AlbumZipSource, variant: AlbumZipVariant): string {
  const projectStoragePath = album.project.storagePath
    || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
  return getAlbumZipStoragePath({
    projectStoragePath,
    albumFolderName: album.storageFolderName || album.name,
    albumName: album.name,
    variant,
  })
}

/**
 * Whether each album ZIP can be downloaded right now. With `includeQueueState`, a ZIP whose
 * (re)generation job is still pending reports not-ready even if an older file exists.
 */
export async function getAlbumZipReadiness(
  album: AlbumZipSource,
  options: { includeQueueState?: boolean } = {},
): Promise<{ fullReady: boolean; socialReady: boolean }> {
  const [fullExists, socialExists] = await Promise.all([
    albumZipExists(getAlbumZipPath(album, 'full')),
    album.socialCopiesEnabled ? albumZipExists(getAlbumZipPath(album, 'social')) : Promise.resolve(false),
  ])

  if (!options.includeQueueState) {
    return { fullReady: fullExists, socialReady: album.socialCopiesEnabled && socialExists }
  }

  let fullPending = false
  let socialPending = false
  try {
    const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
    const zipQueue = getAlbumPhotoZipQueue()
    const [fullJob, socialJob] = await Promise.all([
      zipQueue.getJob(getAlbumZipJobId({ albumId: album.id, variant: 'full' })),
      zipQueue.getJob(getAlbumZipJobId({ albumId: album.id, variant: 'social' })),
    ])
    const pendingStates = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])
    const [fullState, socialState] = await Promise.all([
      fullJob ? fullJob.getState().catch(() => null) : Promise.resolve(null),
      socialJob ? socialJob.getState().catch(() => null) : Promise.resolve(null),
    ])
    fullPending = Boolean(fullState && pendingStates.has(fullState))
    socialPending = Boolean(socialState && pendingStates.has(socialState))
  } catch {
    // If queue state cannot be read, fall back to file-existence readiness only.
  }

  return {
    fullReady: fullExists && !fullPending,
    socialReady: album.socialCopiesEnabled && socialExists && !socialPending,
  }
}

/** Best-effort: enqueue generation of any missing album ZIP (delayed, deduped by job id). */
export async function enqueueMissingAlbumZips(
  album: Pick<AlbumZipSource, 'id' | 'socialCopiesEnabled'>,
  readiness: { fullReady: boolean; socialReady: boolean },
  variants: AlbumZipVariant[] = ['full', 'social'],
): Promise<void> {
  const missing = variants.filter((variant) =>
    variant === 'full' ? !readiness.fullReady : album.socialCopiesEnabled && !readiness.socialReady
  )
  if (missing.length === 0) return
  try {
    const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
    const q = getAlbumPhotoZipQueue()
    for (const variant of missing) {
      const jobId = getAlbumZipJobId({ albumId: album.id, variant })
      await q.remove(jobId).catch(() => {})
      await q.add('generate-album-zip', { albumId: album.id, variant }, { jobId, delay: 10_000 }).catch(() => {})
    }
  } catch {
    // ignore
  }
}

export interface AlbumPhotoRow {
  id: string
  fileName: string
  createdAt: Date
  thumbnailStatus: string
  socialStatus: string
}

/**
 * Per-photo URLs for a client album view. Thumbnails and lightbox previews are presigned
 * direct-to-bucket in S3 mode (the token URLs are only a local-mode fallback); full-size and
 * download URLs stay token URLs so downloads keep going through the analytics-recording route.
 *
 * SECURITY: no authorization here — callers must already have verified access to the album.
 */
export async function buildAlbumPhotoPayloads(params: {
  photos: AlbumPhotoRow[]
  albumId: string
  projectId: string
  request: NextRequest
  sessionId: string
}) {
  const { photos, albumId, projectId, request, sessionId } = params

  const [directThumbUrls, directPreviewUrls] = await Promise.all([
    presignAlbumPhotoThumbnailUrls(photos.filter((p) => p.thumbnailStatus === 'READY').map((p) => p.id)),
    presignAlbumPhotoPreviewUrls(photos),
  ])

  return Promise.all(
    photos.map(async (p) => {
      const tokenValue = await generateAlbumPhotoAccessToken({ photoId: p.id, albumId, projectId, request, sessionId })
      return {
        id: p.id,
        fileName: p.fileName,
        fileSize: '0', // From StoredFile if needed
        createdAt: p.createdAt,
        url: `/api/content/photo/${tokenValue}`,
        thumbnailUrl: directThumbUrls.get(p.id) ?? `/api/content/photo/${tokenValue}?variant=thumbnail`,
        previewUrl: directPreviewUrls.get(p.id) ?? `/api/content/photo/${tokenValue}?variant=preview`,
        downloadUrl: `/api/content/photo/${tokenValue}?download=true`,
        socialDownloadUrl: `/api/content/photo/${tokenValue}?download=true&variant=social`,
        socialReady: p.socialStatus === 'READY',
        thumbnailReady: p.thumbnailStatus === 'READY',
      }
    })
  )
}
