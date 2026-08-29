import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { copyDirectory, copyFile, deleteDirectory, getFilePath, listStoredFileSizes } from '@/lib/storage'
import { getStoredFileRecords, registerStoredFile, type FileRole } from '@/lib/stored-file'
import { publishProjectEvent } from '@/lib/project-events'
import { readCuesForVideo, writeCuesForVideo } from '@/lib/subtitle-store'
import {
  allocateUniqueStorageName,
  buildVideoAssetPreviewsRoot,
  buildVideoAssetStoragePath,
  buildProjectStorageRoot,
} from '@/lib/project-storage-paths'
import { recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { enqueueShareUploadPreview, getAssetTimelineQueue } from '@/lib/queue'
import { isS3Mode, s3GetFileSize } from '@/lib/s3-storage'
import { z } from 'zod'
export const runtime = 'nodejs'

async function getLogicalFileSize(filePath: string): Promise<number> {
  if (isS3Mode()) {
    const size = await s3GetFileSize(filePath)
    if (typeof size === 'number' && size >= 0) return size
    throw new Error(`Failed to determine file size for ${filePath}`)
  }

  const stats = await fs.promises.stat(getFilePath(filePath))
  return stats.size
}

const copyAssetsSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1, 'No assets selected for copying').max(50, 'Too many assets selected'),
  targetVideoId: z.string().min(1, 'Target video version not specified'),
})

// POST /api/videos/[id]/assets/copy-to-version - Copy assets to another video version
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 1. AUTHENTICATION
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'projectsFullControl')
  if (forbiddenAction) return forbiddenAction

  // 2. RATE LIMITING
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 20,
      message: 'Too many asset copy requests. Please slow down.',
    },
    'copy-assets-to-version'
  )
  if (rateLimitResult) return rateLimitResult

  const { id: sourceVideoId } = await params

  try {
    const body = await request.json()
    const parsed = copyAssetsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      )
    }
    const { assetIds, targetVideoId } = parsed.data

    // Verify source video exists and fetch project context
    const sourceVideo = await prisma.video.findUnique({
      where: { id: sourceVideoId },
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
        version: true,
        versionLabel: true,
        project: {
          select: {
            status: true,
            storagePath: true,
            title: true,
            companyName: true,
            assignedUsers: { select: { userId: true } },
            client: { select: { name: true } },
          },
        },
      },
    })

    if (!sourceVideo) {
      return NextResponse.json({ error: 'Source video not found' }, { status: 404 })
    }

    const project = sourceVideo.project
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = project.assignedUsers?.some((u) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Verify target video exists and is in same project; fetch storage fields
    const targetVideo = await prisma.video.findUnique({
      where: { id: targetVideoId },
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
        version: true,
        versionLabel: true,
      },
    })

    if (!targetVideo) {
      return NextResponse.json({ error: 'Target video not found' }, { status: 404 })
    }

    if (sourceVideo.projectId !== targetVideo.projectId) {
      return NextResponse.json(
        { error: 'Cannot copy assets between different projects' },
        { status: 400 }
      )
    }

    // Get all requested assets with their StoredFile records
    const assets = await prisma.videoAsset.findMany({
      where: {
        id: { in: assetIds },
        videoId: sourceVideoId,
      },
    })

    if (assets.length === 0) {
      return NextResponse.json({ error: 'No valid assets found' }, { status: 404 })
    }

    // Batch-load StoredFile for all assets. Every row is kept, not just ORIGINAL: the
    // generated artifacts are cloned from these rows rather than re-derived.
    type StoredRow = {
      entityId: string
      fileRole: FileRole
      storagePath: string
      fileName: string | null
      fileSize: bigint | null
      status: string | null
      generatedAt: Date | null
    }
    const assetStoredFiles = (await getStoredFileRecords('VIDEO_ASSET', assets.map(a => a.id), {
      select: { entityId: true, fileRole: true, storagePath: true, fileName: true, fileSize: true, status: true, generatedAt: true },
    })) as unknown as StoredRow[]
    const storedByAsset = new Map<string, { rows: StoredRow[]; byRole: Map<string, StoredRow> }>()
    for (const sf of assetStoredFiles) {
      let entry = storedByAsset.get(sf.entityId)
      if (!entry) { entry = { rows: [], byRole: new Map() }; storedByAsset.set(sf.entityId, entry) }
      entry.rows.push(sf)
      entry.byRole.set(sf.fileRole, sf)
    }

    // Resolve project and target version path components
    const clientName = project.client?.name || project.companyName || 'Client'
    const projectStoragePath =
      project.storagePath ||
      buildProjectStorageRoot(clientName, project.title)
    const targetVideoFolderName = targetVideo.storageFolderName || targetVideo.name
    const targetVersionLabel = targetVideo.versionLabel || `v${targetVideo.version}`
    const targetExistingAssets = await prisma.videoAsset.findMany({
      where: { videoId: targetVideoId },
      select: { id: true, fileName: true },
    })
    const targetExistingStored = targetExistingAssets.length > 0
      ? await getStoredFileRecords('VIDEO_ASSET', targetExistingAssets.map((a) => a.id), { select: { storagePath: true } })
      : []
    const reservedStorageNames = new Set(
      targetExistingStored
        .map((asset) => path.posix.basename(String(asset.storagePath || '')))
        .filter(Boolean)
    )
    // Duplicate guard. allocateUniqueStorageName only uniquifies the on-disk name, so a
    // second copy of the same file lands as a distinct row with an identical DISPLAY name:
    // the target list shows two indistinguishable entries and the bytes are stored twice.
    // Skip those and report them instead. (Subtitles are exempt — they have deliberate
    // replace semantics, see below.)
    const targetExistingFileNames = new Set(
      targetExistingAssets.map((a) => String(a.fileName || '').trim().toLowerCase()).filter(Boolean)
    )

    type CopyOutcome = { fileName: string; status: 'copied' | 'skipped' | 'failed'; reason?: string }
    const results: CopyOutcome[] = []
    let copiedCount = 0

    // Physically copy each asset file to the target version's assets folder.
    // Per-asset isolation: assets copied before a failure are already committed to the DB
    // and storage, so an uncaught throw would report total failure for a partial success.
    for (const asset of assets) {
      try {
        // Subtitles are dual-artifact (SRT VideoAsset + playback VTT). A plain file
        // clone would give the target an SRT but no VTT, so captions wouldn't play.
        // Instead, read the source video's cues and write BOTH artifacts on the
        // target (replace semantics — one subtitles asset per video), then mark the
        // target READY so its captions show and auto-gen won't clobber them.
        if (asset.category === 'subtitles') {
          const { cues } = await readCuesForVideo(sourceVideoId)
          if (cues.length === 0) {
            results.push({ fileName: asset.fileName, status: 'skipped', reason: 'source version has no subtitle cues' })
            continue
          }
          await writeCuesForVideo(targetVideoId, cues, {
            uploadedByName: `Copied from ${sourceVideo.versionLabel || `v${sourceVideo.version}`}`,
          })
          await prisma.video.update({
            where: { id: targetVideoId },
            data: { transcriptionStatus: 'READY', transcriptionError: null },
          }).catch(() => {})
          copiedCount++
          results.push({ fileName: asset.fileName, status: 'copied' })
          continue
        }

        if (targetExistingFileNames.has(String(asset.fileName || '').trim().toLowerCase())) {
          results.push({ fileName: asset.fileName, status: 'skipped', reason: 'already on the target version' })
          continue
        }

        const stored = storedByAsset.get(asset.id)
        const originalStored = stored?.byRole.get('ORIGINAL')
        const sourcePath = originalStored?.storagePath
        if (!sourcePath) {
          results.push({ fileName: asset.fileName, status: 'skipped', reason: 'no stored file registered for this asset' })
          continue
        }

        const uniqueStorageFileName = allocateUniqueStorageName(asset.fileName, reservedStorageNames)
        reservedStorageNames.add(uniqueStorageFileName)

        const newStoragePath = buildVideoAssetStoragePath(
          projectStoragePath,
          targetVideoFolderName,
          targetVersionLabel,
          uniqueStorageFileName,
        )

        // Content-length is authoritative in S3 mode, so a missing registry size would
        // write a truncated (or empty) object rather than fail — resolve the real size.
        const originalSize = originalStored.fileSize != null && Number(originalStored.fileSize) > 0
          ? Number(originalStored.fileSize)
          : await getLogicalFileSize(sourcePath)

        // Server-side copy in S3 mode: the object is duplicated inside the bucket rather
        // than streamed down to this process and back up again.
        await copyFile(sourcePath, newStoragePath)

        const normalizedType = String(asset.fileType || '').toLowerCase()
        const isVideoAsset = normalizedType.startsWith('video/')
        const isImageAsset = normalizedType.startsWith('image/')

        // Create the new asset first so its generated artifacts can be keyed by the new
        // asset's stable ID (they are ID-keyed and rename-immune).
        const newAsset = await prisma.videoAsset.create({
          data: {
            videoId: targetVideoId,
            fileName: asset.fileName,
            fileType: asset.fileType,
            category: asset.category,
            uploadedByName: asset.uploadedByName,
            // Media metadata describes the bytes we just copied, so it carries over as-is —
            // without it the copy loses its duration/dimensions and any regeneration job
            // below has nothing to work from.
            mediaDurationSeconds: asset.mediaDurationSeconds,
            mediaWidth: asset.mediaWidth,
            mediaHeight: asset.mediaHeight,
            // Readiness flags are set once we know what was cloned, below.
          },
        })

        // Register the copied original file in StoredFile
        await registerStoredFile({
          entityType: 'VIDEO_ASSET', entityId: newAsset.id, fileRole: 'ORIGINAL',
          storagePath: newStoragePath, fileName: asset.fileName, fileSize: BigInt(originalSize),
        })

        // ---------------------------------------------------------------------------
        // Clone the generated artifacts rather than re-deriving them.
        //
        // Every artifact an asset generates — poster JPG, HLS bundle, timeline sprites and
        // their VTT — lives under ONE per-asset root: previews/{projectId}/videos/{videoId}/
        // assets/{assetId}/ (buildVideoAssetPreviewsRoot). Nothing inside references its own
        // asset id: HLS master playlists point at `{label}/index.m3u8`, variant playlists at
        // bare segment names, and the sprite VTT at bare sprite filenames. So copying that
        // whole prefix to the new asset's root is internally consistent by construction, and
        // it saves re-encoding an HLS bundle we already have byte-for-byte.
        // ---------------------------------------------------------------------------
        const sourceArtifactRoot = buildVideoAssetPreviewsRoot(sourceVideo.projectId, sourceVideoId, asset.id)
        const targetArtifactRoot = buildVideoAssetPreviewsRoot(sourceVideo.projectId, targetVideoId, newAsset.id)

        // Only rows that actually live under the artifact root can be re-based by prefix;
        // anything registered elsewhere is left to regeneration rather than mis-pointed.
        const derivedRows = (stored?.rows ?? []).filter((row) =>
          row.fileRole !== 'ORIGINAL' && String(row.storagePath || '').startsWith(`${sourceArtifactRoot}/`)
        )

        const clonedRoles = new Set<string>()
        if (derivedRows.length > 0) {
          // A registry row whose object is gone (stale row, manual bucket edit) must not
          // become a clone row pointing at nothing — an empty listing means "nothing to
          // clone", not "clone verified".
          const sourceArtifacts = await listStoredFileSizes(sourceArtifactRoot)
          let cloneComplete = sourceArtifacts.size > 0
          let shortfall = ''

          if (cloneComplete) {
            await copyDirectory(sourceArtifactRoot, targetArtifactRoot)
            const targetArtifacts = await listStoredFileSizes(targetArtifactRoot)

            // Completeness gate, mirroring verifyHlsBundleComplete: a half-copied bundle must
            // never be registered as playable. Compare every source file against its clone by
            // size — two listings, no per-file HEAD.
            const incomplete = [...sourceArtifacts.entries()].filter(([sourceFilePath, size]) => {
              const clonePath = `${targetArtifactRoot}${sourceFilePath.slice(sourceArtifactRoot.length)}`
              return (targetArtifacts.get(clonePath) ?? -1) !== size
            })
            cloneComplete = incomplete.length === 0
            shortfall = `${incomplete.length}/${sourceArtifacts.size} file(s) missing or short`
          } else {
            shortfall = `${derivedRows.length} registered artifact row(s) but no files on storage`
          }

          if (!cloneComplete) {
            // Drop any partial tree and fall through to regeneration below.
            console.warn(
              `[copy-to-version] Artifact clone incomplete for asset ${asset.id} → ${newAsset.id} ` +
              `(${shortfall}) — falling back to regeneration`
            )
            await deleteDirectory(targetArtifactRoot).catch(() => {})
          } else {
            for (const row of derivedRows) {
              await registerStoredFile({
                entityType: 'VIDEO_ASSET',
                entityId: newAsset.id,
                fileRole: row.fileRole,
                storagePath: `${targetArtifactRoot}${String(row.storagePath).slice(sourceArtifactRoot.length)}`,
                fileName: row.fileName ?? null,
                fileSize: row.fileSize ?? null,
                status: row.status ?? null,
                generatedAt: row.generatedAt ?? null,
              })
              clonedRoles.add(row.fileRole)
            }
          }
        }

        await prisma.videoAsset.update({
          where: { id: newAsset.id },
          data: {
            previewStatus: clonedRoles.has('PREVIEW_IMAGE') ? asset.previewStatus : null,
            previewGeneratedAt: clonedRoles.has('PREVIEW_IMAGE') ? asset.previewGeneratedAt : null,
            timelinePreviewsReady: clonedRoles.has('TIMELINE_SPRITES'),
            // hls-reconcile selects `hlsReady: false`, so a video asset that still owes a
            // bundle must say false rather than NULL or the retry sweep can't see it.
            hlsReady: isVideoAsset ? clonedRoles.has('HLS_PLAYLIST') : null,
          },
        })

        // Whatever couldn't be cloned is queued the way a fresh upload would get it. The
        // preview processor reuses a poster that IS present and only encodes the missing
        // HLS bundle, so a partial clone doesn't cost a full regeneration.
        const needsPoster = (isImageAsset || isVideoAsset) && !clonedRoles.has('PREVIEW_IMAGE')
        const needsHls = isVideoAsset && !clonedRoles.has('HLS_PLAYLIST')
        if (needsPoster || needsHls) {
          await enqueueShareUploadPreview({
            type: 'videoAsset',
            recordId: newAsset.id,
            storagePath: newStoragePath,
            fileType: asset.fileType,
            fileName: asset.fileName,
            durationSeconds: asset.mediaDurationSeconds,
          })
        }
        if (isVideoAsset && asset.timelinePreviewsReady && !clonedRoles.has('TIMELINE_SPRITES')) {
          await getAssetTimelineQueue().add('process-asset-timeline', {
            assetId: newAsset.id,
            videoId: targetVideoId,
            projectId: sourceVideo.projectId,
            storagePath: newStoragePath,
            durationSeconds: asset.mediaDurationSeconds ?? 0,
            width: asset.mediaWidth ?? 0,
            height: asset.mediaHeight ?? 0,
          })
        }

        targetExistingFileNames.add(String(asset.fileName || '').trim().toLowerCase())
        copiedCount++
        results.push({ fileName: asset.fileName, status: 'copied' })
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        console.error(`[copy-to-version] Failed to copy asset ${asset.id} (${asset.fileName}):`, reason)
        results.push({ fileName: asset.fileName, status: 'failed', reason })
      }
    }

    if (copiedCount > 0) {
      await Promise.allSettled([
        recalculateAndStoreProjectTotalBytes(sourceVideo.projectId),
        recalculateAndStoreProjectPreviewBytes(sourceVideo.projectId),
      ])

      // Notify open share pages / admin views so the copied downloads appear live.
      await publishProjectEvent(sourceVideo.projectId, 'video')
    }

    const skippedCount = results.filter((r) => r.status === 'skipped').length
    const failedCount = results.filter((r) => r.status === 'failed').length

    return NextResponse.json({
      success: failedCount === 0,
      message: `Copied ${copiedCount} of ${results.length} asset(s) to the target version`,
      copiedCount,
      skippedCount,
      failedCount,
      results,
    })
  } catch (error) {
    console.error('Error copying assets to version:', error)
    return NextResponse.json(
      { error: 'Failed to copy assets' },
      { status: 500 }
    )
  }
}
