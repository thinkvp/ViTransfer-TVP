import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteFile, deleteDirectory } from '@/lib/storage'
import type { FileRole } from '@/lib/stored-file'
import { getStoredFileRecords, deleteStoredFilesByCriteria, deleteStoredFilesByIds } from '@/lib/stored-file'
import { recalculateAndStoreProjectDiskBytes, recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'

export const runtime = 'nodejs'

/**
 * POST /api/settings/delete-closed-project-previews
 *
 * For all CLOSED projects, deletes only the heavy playable renditions —
 * video previews (480p, 720p, 1080p) and the video-asset playback MP4.
 * Everything needed to still browse the FILES area is preserved: video
 * thumbnails, timeline sprites/VTT, and the video-asset still image.
 *
 * Body: { dryRun?: boolean }   (default true — counts what would be deleted)
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 10 }, 'delete-closed-project-previews')
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => ({}))
  const dryRun = body.dryRun !== false

  try {
    // Find all CLOSED projects
    const closedProjects = await prisma.project.findMany({
      where: { status: 'CLOSED' },
      select: { id: true, title: true },
    })

    const closedProjectIds = closedProjects.map(p => p.id)
    if (closedProjectIds.length === 0) {
      return NextResponse.json({
        ok: true, dryRun, closedProjects: 0, projectsWithPreviews: 0,
        videosWithPreviews: 0, previewFiles: 0,
      })
    }

    // Map each video / asset back to its owning project.
    const videos = await prisma.video.findMany({
      where: { projectId: { in: closedProjectIds } },
      select: { id: true, projectId: true },
    })
    const assets = await prisma.videoAsset.findMany({
      where: { video: { projectId: { in: closedProjectIds } } },
      select: { id: true, video: { select: { projectId: true } } },
    })
    const videoIds = videos.map(v => v.id)
    const assetIds = assets.map(a => a.id)
    const videoToProject = new Map(videos.map(v => [v.id, v.projectId]))
    const assetToProject = new Map(assets.map(a => [a.id, a.video.projectId]))

    // Only the heavy playable renditions: video 480/720/1080 and asset playback MP4.
    // Thumbnails, timeline sprites/VTT and asset still images are intentionally kept.
    const videoPreviewRoles: FileRole[] = ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080']
    const assetPreviewRoles: FileRole[] = ['PREVIEW_MP4']
    // HLS bundles (hls/ dir per video + per asset) are heavy playable renditions too —
    // since direct-to-HLS they're usually the ONLY playable rendition, so they must be
    // counted and deleted alongside any legacy MP4 previews.
    const hlsDirRoles: FileRole[] = ['HLS_SEGMENTS']
    const [videoStored, assetStored, videoHlsDirs, assetHlsDirs] = await Promise.all([
      videoIds.length > 0 ? getStoredFileRecords('VIDEO', videoIds, { fileRoles: videoPreviewRoles, select: { id: true, storagePath: true, entityId: true } }) : [],
      assetIds.length > 0 ? getStoredFileRecords('VIDEO_ASSET', assetIds, { fileRoles: assetPreviewRoles, select: { id: true, storagePath: true, entityId: true } }) : [],
      videoIds.length > 0 ? getStoredFileRecords('VIDEO', videoIds, { fileRoles: hlsDirRoles, select: { id: true, storagePath: true, entityId: true } }) : [],
      assetIds.length > 0 ? getStoredFileRecords('VIDEO_ASSET', assetIds, { fileRoles: hlsDirRoles, select: { id: true, storagePath: true, entityId: true } }) : [],
    ])

    // Each individual MP4 preview file, annotated with its owning project + registry row id.
    const previewFiles = [
      ...videoStored.map(sf => ({ id: sf.id as string, projectId: videoToProject.get(sf.entityId) ?? null, storagePath: sf.storagePath })),
      ...assetStored.map(sf => ({ id: sf.id as string, projectId: assetToProject.get(sf.entityId) ?? null, storagePath: sf.storagePath })),
    ]
    // Each HLS bundle directory, annotated with its owning project + entity. Deleted as a whole tree.
    const hlsBundles = [
      ...videoHlsDirs.map(sf => ({ entityType: 'VIDEO' as const, entityId: sf.entityId as string, projectId: videoToProject.get(sf.entityId) ?? null, storagePath: sf.storagePath })),
      ...assetHlsDirs.map(sf => ({ entityType: 'VIDEO_ASSET' as const, entityId: sf.entityId as string, projectId: assetToProject.get(sf.entityId) ?? null, storagePath: sf.storagePath })),
    ]
    // Total deletable artifacts (MP4 files + HLS bundles) — drives the UI's "preview files" count.
    const totalArtifacts = previewFiles.length + hlsBundles.length

    // Aggregate for the summary the settings UI renders. A video/asset "has previews"
    // if it has either an MP4 preview or an HLS bundle.
    const videosWithRendition = new Set<string>([
      ...videoStored.map(sf => sf.entityId),
      ...videoHlsDirs.map(sf => sf.entityId),
    ])
    const videosWithPreviews = videosWithRendition.size
    const projectVideoCount = new Map<string, Set<string>>()
    for (const sf of [...videoStored, ...videoHlsDirs]) {
      const projectId = videoToProject.get(sf.entityId)
      if (!projectId) continue
      let set = projectVideoCount.get(projectId)
      if (!set) { set = new Set(); projectVideoCount.set(projectId, set) }
      set.add(sf.entityId)
    }
    const projectsWithPreviews = new Set(
      [...previewFiles, ...hlsBundles].map(f => f.projectId).filter((p): p is string => !!p)
    ).size
    const sampleProjects = closedProjects
      .filter(p => projectVideoCount.has(p.id))
      .slice(0, 20)
      .map(p => ({ id: p.id, title: p.title, videos: projectVideoCount.get(p.id)?.size ?? 0 }))

    // Dry run: report what would be deleted without touching storage or the registry.
    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        closedProjects: closedProjects.length,
        projectsWithPreviews,
        videosWithPreviews,
        previewFiles: totalArtifacts,
        sample: { projects: sampleProjects },
      })
    }

    let deletedFiles = 0
    let deletedFilesFailed = 0
    const errors: Array<{ projectId: string; path: string; error: string }> = []

    // Only drop a StoredFile row when its storage delete actually succeeded — a failed
    // delete must leave the row intact so this action stays idempotent (a re-run retries
    // it) instead of orphaning the file with no registry pointer to find it again. Storage
    // deletes are no-ops on already-missing paths, so "already gone" still counts as success.
    const deletedPreviewIds: string[] = []
    await Promise.allSettled(
      previewFiles.map(async (f) => {
        try {
          await deleteFile(f.storagePath)
          deletedFiles++
          deletedPreviewIds.push(f.id)
        } catch (e: any) {
          deletedFilesFailed++
          errors.push({ projectId: f.projectId ?? 'unknown', path: f.storagePath, error: String(e?.message || e) })
        }
      })
    )

    // Delete the HLS bundle directories (whole hls/ trees). A successful delete removes the
    // master playlist + every segment, so on success we drop BOTH the HLS_SEGMENTS and
    // HLS_PLAYLIST rows for that entity and clear hlsReady.
    const deletedVideoHlsIds: string[] = []
    const deletedAssetHlsIds: string[] = []
    await Promise.allSettled(
      hlsBundles.map(async (b) => {
        try {
          await deleteDirectory(b.storagePath)
          deletedFiles++
          if (b.entityType === 'VIDEO') deletedVideoHlsIds.push(b.entityId)
          else deletedAssetHlsIds.push(b.entityId)
        } catch (e: any) {
          deletedFilesFailed++
          errors.push({ projectId: b.projectId ?? 'unknown', path: b.storagePath, error: String(e?.message || e) })
        }
      })
    )

    // Drop the MP4 preview rows whose files were actually removed.
    if (deletedPreviewIds.length > 0) {
      await deleteStoredFilesByIds(deletedPreviewIds)
    }
    // Drop the HLS rows + clear hlsReady only for bundles actually removed, so the DB
    // reflects reality and (on re-open) the reconcile/backfill sweep regenerates them —
    // those sweeps skip CLOSED projects, so they won't rebuild while it stays closed.
    if (deletedVideoHlsIds.length > 0) {
      await deleteStoredFilesByCriteria({ entityType: 'VIDEO', entityIds: deletedVideoHlsIds, fileRoles: ['HLS_PLAYLIST', 'HLS_SEGMENTS'] })
      await prisma.video.updateMany({ where: { id: { in: deletedVideoHlsIds } }, data: { hlsReady: false } }).catch(() => {})
    }
    if (deletedAssetHlsIds.length > 0) {
      await deleteStoredFilesByCriteria({ entityType: 'VIDEO_ASSET', entityIds: deletedAssetHlsIds, fileRoles: ['HLS_PLAYLIST', 'HLS_SEGMENTS'] })
      await prisma.videoAsset.updateMany({ where: { id: { in: deletedAssetHlsIds } }, data: { hlsReady: false } }).catch(() => {})
    }

    // Refresh precomputed storage totals per project so freed space shows up
    // immediately instead of waiting for the daily reconcile job.
    await Promise.allSettled(
      closedProjectIds.flatMap(projectId => [
        recalculateAndStoreProjectTotalBytes(projectId),
        recalculateAndStoreProjectPreviewBytes(projectId),
        recalculateAndStoreProjectDiskBytes(projectId),
      ])
    )

    return NextResponse.json({
      ok: true,
      dryRun: false,
      closedProjects: closedProjects.length,
      projectsWithPreviews,
      videosWithPreviews,
      previewFiles: totalArtifacts,
      deleted: { previewFiles: deletedFiles, previewFilesFailed: deletedFilesFailed },
      ...(errors.length > 0 ? { errors } : {}),
      sample: { projects: sampleProjects },
    })
  } catch (error) {
    console.error('Error deleting closed project previews:', error)
    return NextResponse.json({ error: 'Failed to delete closed project previews' }, { status: 500 })
  }
}
