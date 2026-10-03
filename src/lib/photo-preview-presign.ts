import { getStoredFileRecords } from '@/lib/stored-file'
import { isS3Mode, s3GetPresignedStreamUrl } from '@/lib/s3-storage'

// Matches the inline-image expiry /api/content/photo uses for its own redirects.
const PREVIEW_URL_TTL_SECONDS = 14400

/**
 * S3 mode: presign each photo's lightbox preview straight to the bucket.
 *
 * The token URL (`/api/content/photo/<token>?variant=preview`) has a unique,
 * extension-less last path segment per photo. CrowdSec's http-crawl-non_statics
 * rule counts those as distinct pages (40 = ban), so paging through a large album
 * in the lightbox banned the viewer's IP — the same failure the thumbnail presign
 * fixed for the grid. Same choice as the content route: the SOCIAL derivative
 * when ready, else the original.
 *
 * Returns an empty map in local mode; callers keep the token URL as the fallback.
 * SECURITY: no authorization — callers must have verified access to every photo.
 */
export async function presignAlbumPhotoPreviewUrls(
  photos: Array<{ id: string; socialStatus?: string | null }>,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  if (!isS3Mode() || photos.length === 0) return urls

  const records = await getStoredFileRecords(
    'ALBUM_PHOTO',
    photos.map((p) => p.id),
    { fileRoles: ['ORIGINAL', 'SOCIAL'], select: { entityId: true, fileRole: true, storagePath: true } },
  )
  const pathByKey = new Map(records.map((r) => [`${r.entityId}:${r.fileRole}`, r.storagePath as string]))

  await Promise.all(
    photos.map(async (p) => {
      const socialPath = p.socialStatus === 'READY' ? pathByKey.get(`${p.id}:SOCIAL`) : undefined
      const path = socialPath || pathByKey.get(`${p.id}:ORIGINAL`)
      if (!path) return
      try {
        urls.set(p.id, await s3GetPresignedStreamUrl(path, PREVIEW_URL_TTL_SECONDS, 'image/jpeg'))
      } catch {
        // Best-effort; the token URL still works.
      }
    }),
  )
  return urls
}
