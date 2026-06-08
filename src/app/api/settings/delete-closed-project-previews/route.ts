import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteFile } from '@/lib/storage'

export const runtime = 'nodejs'

/**
 * POST /api/settings/delete-closed-project-previews
 *
 * Deletes project video previews (480p, 720p, 1080p) and video-asset
 * playback previews for all CLOSED projects. Timeline sprites are preserved
 * since they are small and regenerating them is costly.
 *
 * Body: { dryRun?: boolean }   (default true)
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
    // Find all CLOSED projects that still have videos with preview paths
    const closedProjects = await prisma.project.findMany({
      where: { status: 'CLOSED' },
      select: {
        id: true,
        title: true,
        videos: {
          where: {
            OR: [
              { preview480Path: { not: null } },
              { preview720Path: { not: null } },
              { preview1080Path: { not: null } },
            ],
          },
          select: {
            id: true,
            preview480Path: true,
            preview720Path: true,
            preview1080Path: true,
          },
        },
      },
    })

    const closedProjectIds = closedProjects.map((p) => p.id)
    const closedProjectAssetPreviews = closedProjectIds.length > 0
      ? await prisma.videoAsset.findMany({
          where: {
            video: { projectId: { in: closedProjectIds } },
            previewPath: { not: null },
          },
          select: {
            id: true,
            previewPath: true,
            fileType: true,
            previewStatus: true,
            video: {
              select: {
                projectId: true,
              },
            },
          },
        })
      : []

    const assetPreviewsByProjectId = new Map<string, Array<{ id: string; previewPath: string; previewStatus: string | null }>>()
    for (const asset of closedProjectAssetPreviews) {
      const previewPath = String(asset.previewPath || '').trim()
      const isVideoAsset = String(asset.fileType || '').toLowerCase().startsWith('video/')
      const hasPlaybackPreview = previewPath.toLowerCase().endsWith('.mp4')
      if (!previewPath || !isVideoAsset || !hasPlaybackPreview) continue
      const projectId = asset.video.projectId
      const current = assetPreviewsByProjectId.get(projectId) || []
      current.push({ id: asset.id, previewPath, previewStatus: asset.previewStatus })
      assetPreviewsByProjectId.set(projectId, current)
    }

    // Only include projects that actually have video previews/timelines or asset previews
    const projectsWithPreviews = closedProjects.filter((project) => {
      const assetPreviews = assetPreviewsByProjectId.get(project.id) || []
      return project.videos.length > 0 || assetPreviews.length > 0
    })

    let totalProjects = projectsWithPreviews.length
    let totalVideos = 0
    let totalVideoAssets = 0
    let totalPreviewFiles = 0
    let deletedPreviewFiles = 0
    let failedPreviewFiles = 0
    const errors: Array<{ projectId: string; path: string; error: string }> = []

    for (const project of projectsWithPreviews) {
      const projectAssetPreviews = assetPreviewsByProjectId.get(project.id) || []

      for (const video of project.videos) {
        totalVideos++

        const previewPaths = [
          video.preview480Path,
          video.preview720Path,
          video.preview1080Path,
        ].filter(Boolean) as string[]
        totalPreviewFiles += previewPaths.length

        if (!dryRun) {
          const updateData: Record<string, null> = {}

          // Delete preview files
          for (const path of previewPaths) {
            try {
              await deleteFile(path)
              deletedPreviewFiles++
            } catch (err: any) {
              failedPreviewFiles++
              errors.push({ projectId: project.id, path, error: err?.message || 'Unknown error' })
            }
          }

          if (previewPaths.length > 0) {
            updateData.preview480Path = null
            updateData.preview720Path = null
            updateData.preview1080Path = null
          }

          if (Object.keys(updateData).length > 0) {
            await prisma.video.update({
              where: { id: video.id },
              data: updateData,
            })
          }
        }
      }

      for (const asset of projectAssetPreviews) {
        totalVideoAssets++

        totalPreviewFiles += 1

        if (!dryRun) {
          try {
            await deleteFile(asset.previewPath)
            deletedPreviewFiles++
          } catch (err: any) {
            failedPreviewFiles++
            errors.push({ projectId: project.id, path: asset.previewPath, error: err?.message || 'Unknown error' })
          }

          await prisma.videoAsset.update({
            where: { id: asset.id },
            data: {
              previewPath: null,
              previewStatus: asset.previewStatus === 'READY' ? 'READY' : null,
              previewError: null,
              previewFileSize: null,
            },
          }).catch((err: any) => {
            errors.push({
              projectId: project.id,
              path: `videoAsset:${asset.id}`,
              error: err?.message || 'Failed to clear video asset preview metadata',
            })
          })
        }
      }
    }

    // Compute the set of affected projects
    const affectedProjects = projectsWithPreviews
      .slice(0, 10)
      .map(p => ({
        id: p.id,
        title: p.title,
        videos: p.videos.length,
        videoAssets: (assetPreviewsByProjectId.get(p.id) || []).length,
      }))

    return NextResponse.json({
      ok: true,
      dryRun,
      closedProjects: closedProjects.length,
      projectsWithPreviews: totalProjects,
      videosWithPreviews: totalVideos,
      videoAssetsWithPreviews: totalVideoAssets,
      previewFiles: totalPreviewFiles,
      ...(!dryRun
        ? {
            deleted: {
              previewFiles: deletedPreviewFiles,
              previewFilesFailed: failedPreviewFiles,
            },
          }
        : {}),
      ...(errors.length > 0 ? { errors: errors.slice(0, 50) } : {}),
      sample: {
        projects: affectedProjects,
      },
    })
  } catch (err: any) {
    console.error('[delete-closed-project-previews]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
