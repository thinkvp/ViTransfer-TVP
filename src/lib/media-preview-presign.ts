import type { EntityType } from '@prisma/client'
import { getStoredFileRecords } from '@/lib/stored-file'
import { isS3Mode, s3GetPresignedStreamUrl } from '@/lib/s3-storage'

/**
 * S3 mode: presign the small preview artifacts the share-page FILES grid loads in bulk
 * (video-asset posters, timeline VTT indexes and sprite sheets) straight to the bucket.
 *
 * Their token URLs (`/api/content/<token>?…`) give every asset a unique, extension-less
 * last path segment. CrowdSec's http-crawl-non_statics rule counts those as distinct
 * pages (40 = 4h IP ban), so opening a video group with a few dozen assets and hovering
 * their timelines banned the viewer's own IP. Same fix as the album photo presigns.
 *
 * Every function returns an empty map in local mode; callers keep the token URL as the
 * fallback. SECURITY: no authorization — callers must have verified access to every entity.
 */

// Matches the album-photo presigns. The share pages re-fetch the file list (and with it
// fresh URLs) every 10 minutes, so this comfortably outlives the refresh cadence.
const PREVIEW_URL_TTL_SECONDS = 14400

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif']
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mxf']

/**
 * Densest timeline layout any worker writes: one frame per second, 10×10 tiles per sheet
 * (the video processor; asset/upload timelines use 5s frames, so this over-counts them).
 * Sprite names are derived from duration rather than listed from the bucket — signing is
 * local, a name that doesn't exist is never requested (the VTT only names real sheets),
 * and the client falls back to the token URL for any name missing from the map.
 */
const MIN_SECONDS_PER_SPRITE = 100
const MAX_SPRITE_FILES = 1000 // sprite-NNN.jpg

/**
 * Presign each video asset's generated poster (PREVIEW_IMAGE), keyed by assetId.
 * Mirrors the content route's `assetPreview=1` resolution: image and video assets only,
 * previewStatus READY, and the poster path comes straight from the StoredFile registry.
 */
export async function presignVideoAssetPreviewUrls(
  assets: Array<{ id: string; fileName: string; fileType?: string | null; previewStatus?: string | null }>,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  if (!isS3Mode()) return urls

  const eligible = assets.filter((asset) => {
    if (asset.previewStatus !== 'READY') return false
    const ft = String(asset.fileType || '').toLowerCase()
    const ext = asset.fileName.includes('.')
      ? asset.fileName.slice(asset.fileName.lastIndexOf('.') + 1).toLowerCase()
      : ''
    return ft.startsWith('image/') || ft.startsWith('video/') || IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext)
  })
  if (eligible.length === 0) return urls

  const records = await getStoredFileRecords('VIDEO_ASSET', eligible.map((a) => a.id), {
    fileRoles: ['PREVIEW_IMAGE'],
    select: { entityId: true, storagePath: true },
  })
  await Promise.all(
    records.map(async (r) => {
      if (!r.storagePath) return
      try {
        urls.set(r.entityId, await s3GetPresignedStreamUrl(r.storagePath, PREVIEW_URL_TTL_SECONDS, 'image/jpeg'))
      } catch {
        // Best-effort; the token URL still works.
      }
    }),
  )
  return urls
}

export interface PresignedTimeline {
  vttUrl: string
  /** Sprite filename (sprite-NNN.jpg) → presigned URL. */
  spriteUrls: Record<string, string>
}

/**
 * Presign timeline hover previews (VTT index + sprite sheets), keyed by entityId.
 * Only entities with BOTH a TIMELINE_VTT and a TIMELINE_SPRITES row and a known
 * duration are included.
 */
export async function presignTimelineUrls(
  entityType: EntityType,
  entities: Array<{ id: string; durationSeconds: number | null | undefined }>,
): Promise<Map<string, PresignedTimeline>> {
  const out = new Map<string, PresignedTimeline>()
  if (!isS3Mode() || entities.length === 0) return out

  const records = await getStoredFileRecords(entityType, entities.map((e) => e.id), {
    fileRoles: ['TIMELINE_VTT', 'TIMELINE_SPRITES'],
    select: { entityId: true, fileRole: true, storagePath: true },
  })
  const pathByKey = new Map(records.map((r) => [`${r.entityId}:${r.fileRole}`, r.storagePath as string]))

  await Promise.all(
    entities.map(async (entity) => {
      const vttPath = pathByKey.get(`${entity.id}:TIMELINE_VTT`)
      const spritesPath = pathByKey.get(`${entity.id}:TIMELINE_SPRITES`)
      const duration = Number(entity.durationSeconds)
      if (!vttPath || !spritesPath || !Number.isFinite(duration) || duration <= 0) return

      // Same normalisation as the content route: the stored path is the sprite directory
      // (an old backfill stored one sprite file instead — strip it).
      const dir = spritesPath.replace(/sprite-\d{3}\.jpg$/, '')
      const spriteDir = dir.endsWith('/') ? dir : `${dir}/`
      // +1 absorbs rounding between the stored duration and the one the worker probed.
      const spriteCount = Math.min(MAX_SPRITE_FILES, Math.ceil(duration / MIN_SECONDS_PER_SPRITE) + 1)

      try {
        const spriteNames = Array.from({ length: spriteCount }, (_, i) => `sprite-${String(i).padStart(3, '0')}.jpg`)
        const [vttUrl, ...spriteUrlList] = await Promise.all([
          s3GetPresignedStreamUrl(vttPath, PREVIEW_URL_TTL_SECONDS, 'text/vtt'),
          ...spriteNames.map((name) => s3GetPresignedStreamUrl(`${spriteDir}${name}`, PREVIEW_URL_TTL_SECONDS, 'image/jpeg')),
        ])
        const spriteUrls: Record<string, string> = {}
        spriteNames.forEach((name, i) => { spriteUrls[name] = spriteUrlList[i] })
        out.set(entity.id, { vttUrl, spriteUrls })
      } catch {
        // Best-effort; the token URLs still work.
      }
    }),
  )
  return out
}
