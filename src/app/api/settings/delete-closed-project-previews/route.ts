import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteFile, deleteDirectory } from '@/lib/storage'

export const runtime = 'nodejs'

/**
 * POST /api/settings/delete-closed-project-previews
 *
 * Deletes preview files (480p, 720p, 1080p) and timeline sprite directories
 * for all CLOSED projects.
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

  const rateLimitResult = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 10 })
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => ({}))
  const dryRun = body.dryRun !== false

  try {
    // Find all CLOSED projects that still have videos with preview paths or timeline sprites
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
              { timelinePreviewSpritesPath: { not: null } },
            ],
          },
          select: {
            id: true,
            preview480Path: true,
            preview720Path: true,
            preview1080Path: true,
            timelinePreviewSpritesPath: true,
            timelinePreviewsReady: true,
          },
        },
      },
    })

    // Only include projects that actually have videos with previews
    const projectsWithPreviews = closedProjects.filter(p => p.videos.length > 0)

    let totalProjects = projectsWithPreviews.length
    let totalVideos = 0
    let totalPreviewFiles = 0
    let totalTimelineDirs = 0
    let deletedPreviewFiles = 0
    let failedPreviewFiles = 0
    let deletedTimelineDirs = 0
    let failedTimelineDirs = 0
    const errors: Array<{ projectId: string; path: string; error: string }> = []

    for (const project of projectsWithPreviews) {
      for (const video of project.videos) {
        totalVideos++

        const previewPaths = [
          video.preview480Path,
          video.preview720Path,
          video.preview1080Path,
        ].filter(Boolean) as string[]
        totalPreviewFiles += previewPaths.length

        if (video.timelinePreviewSpritesPath) {
          totalTimelineDirs++
        }

        if (!dryRun) {
          const updateData: Record<string, null | boolean> = {}

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

          // Delete timeline sprite directory
          if (video.timelinePreviewSpritesPath) {
            try {
              await deleteDirectory(video.timelinePreviewSpritesPath)
              deletedTimelineDirs++
            } catch (err: any) {
              failedTimelineDirs++
              errors.push({
                projectId: project.id,
                path: video.timelinePreviewSpritesPath,
                error: err?.message || 'Unknown error',
              })
            }
            updateData.timelinePreviewsReady = false
            updateData.timelinePreviewVttPath = null
            updateData.timelinePreviewSpritesPath = null
          }

          if (Object.keys(updateData).length > 0) {
            await prisma.video.update({
              where: { id: video.id },
              data: updateData,
            })
          }
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
      }))

    return NextResponse.json({
      ok: true,
      dryRun,
      closedProjects: closedProjects.length,
      projectsWithPreviews: totalProjects,
      videosWithPreviews: totalVideos,
      previewFiles: totalPreviewFiles,
      timelineDirs: totalTimelineDirs,
      ...(!dryRun
        ? {
            deleted: {
              previewFiles: deletedPreviewFiles,
              previewFilesFailed: failedPreviewFiles,
              timelineDirs: deletedTimelineDirs,
              timelineDirsFailed: failedTimelineDirs,
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
