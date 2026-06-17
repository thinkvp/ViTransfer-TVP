/**
 * Backfill orphan files into the StoredFile registry.
 *
 * After the migration dropped legacy columns, some derived files (upload previews,
 * timeline sprites, asset previews, album ZIPs) exist on S3/disk but were never
 * registered in StoredFile. This script scans S3, finds unregistered files, and
 * creates StoredFile records for them.
 *
 * Usage:
 *   docker compose run --rm --no-deps app npx tsx scripts/backfill-orphans-to-stored-files.ts
 *
 * Options (env vars):
 *   DRY_RUN=1     — only report what would be registered, don't write
 */

import { prisma } from '../src/lib/db'
import { isS3Mode, getS3Client, getS3Bucket } from '../src/lib/s3-storage'
import { registerStoredFile, getAllStoredPaths } from '../src/lib/stored-file'
import type { EntityType, FileRole } from '../src/lib/stored-file'
import { ListObjectsV2Command } from '@aws-sdk/client-s3'

const DRY_RUN = process.env.DRY_RUN === '1'

// ─── Path pattern matchers ─────────────────────────────────────────────────

/** Matches: .previews/uploads/{uploadFileId}/timeline-previews/index.vtt */
const UPLOAD_TIMELINE_VTT_RE = /\.previews\/uploads\/([a-z0-9]{25})\/timeline-previews\/index\.vtt$/

/** Matches: .previews/uploads/{uploadFileId}/timeline-previews/sprite-000.jpg */
const UPLOAD_TIMELINE_SPRITE_RE = /\.previews\/uploads\/([a-z0-9]{25})\/timeline-previews\/sprite-\d{3}\.jpg$/

/** Matches: .previews/uploads/{filename}.jpg or .mp4.jpg */
const UPLOAD_PREVIEW_RE = /\.previews\/uploads\/(.+)\.(?:mp4\.)?jpg$/

/** Matches: .previews/videos/{videoFolder}/{version}/assets/{filename}.(jpg|png|webp) — but NOT timeline-previews subdir */
const ASSET_PREVIEW_RE = /\.previews\/videos\/([^/]+)\/([^/]+)\/assets\/(?!.*timeline-previews)(.+\.(?:jpg|png|webp))$/

/** Matches: .previews/videos/{videoFolder}/{version}/assets/{assetId}/timeline-previews/index.vtt */
const ASSET_TIMELINE_VTT_RE = /\.previews\/videos\/([^/]+)\/([^/]+)\/assets\/([a-z0-9]{25})\/timeline-previews\/index\.vtt$/

/** Matches: .previews/videos/{videoFolder}/{version}/assets/{assetId}/timeline-previews/sprite-NNN.jpg */
const ASSET_TIMELINE_SPRITE_RE = /\.previews\/videos\/([^/]+)\/([^/]+)\/assets\/([a-z0-9]{25})\/timeline-previews\/sprite-\d{3}\.jpg$/

/** Matches: .previews/videos/{videoFolder}/{version}/thumbnail.jpg */
const VIDEO_THUMBNAIL_RE = /\.previews\/videos\/([^/]+)\/([^/]+)\/thumbnail\.jpg$/

/** Matches: .previews/videos/{videoFolder}/{version}/timeline-previews/index.vtt */
const VIDEO_TIMELINE_VTT_RE = /\.previews\/videos\/([^/]+)\/([^/]+)\/timeline-previews\/index\.vtt$/

/** Matches: .previews/videos/{videoFolder}/{version}/timeline-previews/sprite-NNN.jpg */
const VIDEO_TIMELINE_SPRITE_RE = /\.previews\/videos\/([^/]+)\/([^/]+)\/timeline-previews\/sprite-\d{3}\.jpg$/

/** Matches: albums/{folder}/zips/{name} Full Res.zip */
const ALBUM_ZIP_FULL_RE = /albums\/(?:[^/]+\/)?([^/]+)\/zips\/(.+) Full Res\.zip$/

/** Matches: albums/{folder}/zips/{name} Social Sized.zip */
const ALBUM_ZIP_SOCIAL_RE = /albums\/(?:[^/]+\/)?([^/]+)\/zips\/(.+) Social Sized\.zip$/

/** Files to skip entirely */
const SKIP_PATTERNS = [
  /\.vitransfer_folder$/,
  /\/\.tus-tmp\//,
]

function shouldSkip(path: string): boolean {
  return SKIP_PATTERNS.some(r => r.test(path))
}

// ─── S3 listing ─────────────────────────────────────────────────────────────

async function listAllS3Objects(prefix: string): Promise<Array<{ key: string; size: number }>> {
  const client = getS3Client()
  const bucket = getS3Bucket()
  const results: Array<{ key: string; size: number }> = []
  let continuationToken: string | undefined

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    })
    const response = await client.send(cmd)
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Size != null) {
          results.push({ key: obj.Key, size: obj.Size })
        }
      }
    }
    continuationToken = response.NextContinuationToken
  } while (continuationToken)

  return results
}

// ─── Main migration logic ──────────────────────────────────────────────────

interface OrphanRegistration {
  entityType: EntityType
  entityId: string
  fileRole: FileRole
  storagePath: string
  fileSize: bigint
  status: string
  fileName?: string
}

async function classifyOrphan(
  s3Key: string,
  s3Size: number,
): Promise<OrphanRegistration | null> {
  // Upload timeline VTT
  let m = s3Key.match(UPLOAD_TIMELINE_VTT_RE)
  if (m) {
    const uploadFileId = m[1]
    // Verify the upload file exists
    const exists = await prisma.shareUploadFile.findUnique({ where: { id: uploadFileId }, select: { id: true } })
    if (!exists) { console.log(`  [SKIP] Upload file not found: ${uploadFileId}`); return null }
    return {
      entityType: 'SHARE_UPLOAD_FILE', entityId: uploadFileId, fileRole: 'TIMELINE_VTT',
      storagePath: s3Key, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Upload timeline sprite — store the directory prefix (not individual sprite files).
  // Workers store the directory; content delivery appends /sprite-NNN.jpg at serve time.
  // We only register once per upload file using the directory path.
  m = s3Key.match(UPLOAD_TIMELINE_SPRITE_RE)
  if (m) {
    const uploadFileId = m[1]
    // Check if a TIMELINE_SPRITES entry already exists for this upload file
    const existing = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'SHARE_UPLOAD_FILE', entityId: uploadFileId, fileRole: 'TIMELINE_SPRITES' } },
      select: { id: true },
    })
    if (existing) return null // already registered with the directory path
    const exists = await prisma.shareUploadFile.findUnique({ where: { id: uploadFileId }, select: { id: true } })
    if (!exists) { console.log(`  [SKIP] Upload file not found: ${uploadFileId}`); return null }
    // Derive the directory prefix from the individual sprite file path
    const dirPath = s3Key.replace(/sprite-\d{3}\.jpg$/, '')
    return {
      entityType: 'SHARE_UPLOAD_FILE', entityId: uploadFileId, fileRole: 'TIMELINE_SPRITES',
      storagePath: dirPath, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Upload preview thumbnail (image preview for a share upload file)
  m = s3Key.match(UPLOAD_PREVIEW_RE)
  if (m) {
    const previewFilename = m[1]
    // Find the upload file by matching filename pattern in any project
    const uploadFile = await prisma.shareUploadFile.findFirst({
      where: {
        fileName: { startsWith: previewFilename.split('.')[0] ?? previewFilename },
      },
      select: { id: true, fileName: true },
    })
    if (!uploadFile) { console.log(`  [SKIP] No upload file matches preview: ${previewFilename}`); return null }
    // Upload files always use PREVIEW_IMAGE role; PREVIEW_MP4 is only for VIDEO_ASSET entities
    return {
      entityType: 'SHARE_UPLOAD_FILE', entityId: uploadFile.id,
      fileRole: 'PREVIEW_IMAGE',
      storagePath: s3Key, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Asset preview image
  m = s3Key.match(ASSET_PREVIEW_RE)
  if (m) {
    const [, videoFolder, version, assetFilename] = m
    // Find the asset by filename within any video matching folder/version (case-insensitive)
    const asset = await prisma.videoAsset.findFirst({
      where: {
        fileName: { equals: assetFilename, mode: 'insensitive' },
        video: {
          storageFolderName: videoFolder,
          versionLabel: { equals: version, mode: 'insensitive' },
        },
      },
      select: { id: true, fileName: true },
    })
    if (!asset) { console.log(`  [SKIP] No asset found: ${videoFolder}/${version}/${assetFilename}`); return null }
    return {
      entityType: 'VIDEO_ASSET', entityId: asset.id, fileRole: 'PREVIEW_IMAGE',
      storagePath: s3Key, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Asset timeline VTT
  m = s3Key.match(ASSET_TIMELINE_VTT_RE)
  if (m) {
    const [, , , assetId] = m
    const exists = await prisma.videoAsset.findUnique({ where: { id: assetId }, select: { id: true } })
    if (!exists) { console.log(`  [SKIP] Asset not found: ${assetId}`); return null }
    return {
      entityType: 'VIDEO_ASSET', entityId: assetId, fileRole: 'TIMELINE_VTT',
      storagePath: s3Key, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Asset timeline sprite — store the directory prefix (not individual sprite files).
  // Workers store the directory; content delivery appends /sprite-NNN.jpg at serve time.
  m = s3Key.match(ASSET_TIMELINE_SPRITE_RE)
  if (m) {
    const [, , , assetId] = m
    const existing = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'VIDEO_ASSET', entityId: assetId, fileRole: 'TIMELINE_SPRITES' } },
      select: { id: true },
    })
    if (existing) return null
    const exists = await prisma.videoAsset.findUnique({ where: { id: assetId }, select: { id: true } })
    if (!exists) { console.log(`  [SKIP] Asset not found: ${assetId}`); return null }
    const dirPath = s3Key.replace(/sprite-\d{3}\.jpg$/, '')
    return {
      entityType: 'VIDEO_ASSET', entityId: assetId, fileRole: 'TIMELINE_SPRITES',
      storagePath: dirPath, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Video thumbnail
  m = s3Key.match(VIDEO_THUMBNAIL_RE)
  if (m) {
    const [, videoFolder, version] = m
    const video = await prisma.video.findFirst({
      where: {
        storageFolderName: videoFolder,
        versionLabel: { equals: version, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (!video) { console.log(`  [SKIP] No video found for thumbnail: ${videoFolder}/${version}`); return null }
    return {
      entityType: 'VIDEO', entityId: video.id, fileRole: 'THUMBNAIL',
      storagePath: s3Key, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Video timeline VTT
  m = s3Key.match(VIDEO_TIMELINE_VTT_RE)
  if (m) {
    const [, videoFolder, version] = m
    const video = await prisma.video.findFirst({
      where: {
        storageFolderName: videoFolder,
        versionLabel: { equals: version, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (!video) { console.log(`  [SKIP] No video found: ${videoFolder}/${version}`); return null }
    return {
      entityType: 'VIDEO', entityId: video.id, fileRole: 'TIMELINE_VTT',
      storagePath: s3Key, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Video timeline sprite — store the directory prefix (not individual sprite files).
  // Workers store the directory; content delivery appends /sprite-NNN.jpg at serve time.
  m = s3Key.match(VIDEO_TIMELINE_SPRITE_RE)
  if (m) {
    const [, videoFolder, version] = m
    const video = await prisma.video.findFirst({
      where: {
        storageFolderName: videoFolder,
        versionLabel: { equals: version, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (!video) { console.log(`  [SKIP] No video found: ${videoFolder}/${version}`); return null }
    const existing = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'VIDEO', entityId: video.id, fileRole: 'TIMELINE_SPRITES' } },
      select: { id: true },
    })
    if (existing) return null
    const dirPath = s3Key.replace(/sprite-\d{3}\.jpg$/, '')
    return {
      entityType: 'VIDEO', entityId: video.id, fileRole: 'TIMELINE_SPRITES',
      storagePath: dirPath, fileSize: BigInt(s3Size), status: 'READY',
    }
  }

  // Album ZIP (full)
  m = s3Key.match(ALBUM_ZIP_FULL_RE)
  if (m) {
    const [, albumFolder, albumName] = m
    const album = await prisma.album.findFirst({
      where: { storageFolderName: albumFolder, name: albumName },
      select: { id: true },
    })
    if (!album) { console.log(`  [SKIP] No album found: ${albumFolder}/${albumName}`); return null }
    return {
      entityType: 'ALBUM', entityId: album.id, fileRole: 'ZIP_FULL',
      storagePath: s3Key, fileSize: BigInt(s3Size), status: 'READY',
      fileName: `${albumName} Full Res.zip`,
    }
  }

  // Album ZIP (social)
  m = s3Key.match(ALBUM_ZIP_SOCIAL_RE)
  if (m) {
    const [, albumFolder, albumName] = m
    const album = await prisma.album.findFirst({
      where: { storageFolderName: albumFolder, name: albumName },
      select: { id: true },
    })
    if (!album) { console.log(`  [SKIP] No album found: ${albumFolder}/${albumName}`); return null }
    return {
      entityType: 'ALBUM', entityId: album.id, fileRole: 'ZIP_SOCIAL',
      storagePath: s3Key, fileSize: BigInt(s3Size), status: 'READY',
      fileName: `${albumName} Social Sized.zip`,
    }
  }

  return null
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[backfill-orphans] Starting orphan file backfill...')
  if (DRY_RUN) console.log('[backfill-orphans] DRY RUN — no writes will be performed')

  // Get all currently registered paths (paginated)
  const storedPathSet = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await getAllStoredPaths({ cursor, take: 10000 })
    for (const s of page.items) storedPathSet.add(s.storagePath)
    cursor = page.nextCursor
  } while (cursor)
  console.log(`[backfill-orphans] ${storedPathSet.size} paths currently in StoredFile`)

  if (!isS3Mode()) {
    console.log('[backfill-orphans] Not in S3 mode — local filesystem scan not yet supported by this script')
    console.log('[backfill-orphans] Use the storage integrity scan to find orphans, then re-run in S3 mode')
    await prisma.$disconnect()
    return
  }

  // List all S3 objects
  console.log('[backfill-orphans] Listing S3 objects (this may take a while)...')
  const s3Objects = await listAllS3Objects('')
  console.log(`[backfill-orphans] Found ${s3Objects.length} total S3 objects`)

  // Find orphans
  const orphans = s3Objects.filter(o => !storedPathSet.has(o.key) && !shouldSkip(o.key))
  console.log(`[backfill-orphans] ${orphans.length} potential orphan files to classify`)

  // Classify and register
  let registered = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < orphans.length; i++) {
    const obj = orphans[i]
    const progress = `[${i + 1}/${orphans.length}]`

    try {
      const reg = await classifyOrphan(obj.key, obj.size)
      if (!reg) {
        skipped++
        if (skipped <= 20) console.log(`  ${progress} Unclassified: ${obj.key}`)
        continue
      }

      if (DRY_RUN) {
        console.log(`  ${progress} [DRY RUN] Would register: ${reg.entityType}/${reg.entityId}/${reg.fileRole} → ${reg.storagePath}`)
        registered++
      } else {
        await registerStoredFile(reg)
        console.log(`  ${progress} Registered: ${reg.entityType}/${reg.entityId}/${reg.fileRole}`)
        registered++
      }
    } catch (err: any) {
      failed++
      console.error(`  ${progress} FAILED: ${obj.key} — ${err?.message || err}`)
    }
  }

  console.log(`\n[backfill-orphans] Done:`)
  console.log(`  Registered: ${registered}`)
  console.log(`  Skipped:    ${skipped}`)
  console.log(`  Failed:     ${failed}`)

  const newCount = await prisma.storedFile.count()
  console.log(`  StoredFile total rows: ${newCount}`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('[backfill-orphans] Fatal:', e)
  process.exit(1)
})
