import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteFile } from '@/lib/storage'
import type { FileRole } from '@/lib/stored-file'
import { getStoredFileRecords, deleteStoredFilesByCriteria } from '@/lib/stored-file'

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
    // Find all CLOSED projects
    const closedProjects = await prisma.project.findMany({
      where: { status: 'CLOSED' },
      select: { id: true, title: true },
    })

    const closedProjectIds = closedProjects.map(p => p.id)
    if (closedProjectIds.length === 0) {
      return NextResponse.json({ success: true, totalProjects: 0, deletedPreviewFiles: 0 })
    }

    // Find all videos in closed projects
    const videoIds = (await prisma.video.findMany({
      where: { projectId: { in: closedProjectIds } },
      select: { id: true },
    })).map(v => v.id)

    // Find all video assets in closed projects
    const assetIds = (await prisma.videoAsset.findMany({
      where: { video: { projectId: { in: closedProjectIds } } },
      select: { id: true },
    })).map(a => a.id)

    // Get all preview/timeline StoredFile paths for these entities
    const previewRoles: FileRole[] = ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'PREVIEW_IMAGE', 'PREVIEW_MP4', 'TIMELINE_VTT', 'TIMELINE_SPRITES', 'THUMBNAIL']
    const [videoStored, assetStored] = await Promise.all([
      videoIds.length > 0 ? getStoredFileRecords('VIDEO', videoIds, { fileRoles: previewRoles, select: { storagePath: true, fileRole: true } }) : [],
      assetIds.length > 0 ? getStoredFileRecords('VIDEO_ASSET', assetIds, { fileRoles: ['PREVIEW_IMAGE', 'PREVIEW_MP4'], select: { storagePath: true } }) : [],
    ])

    const allStored = [...videoStored, ...assetStored]
    let deletedPreviewFiles = 0
    let failedPreviewFiles = 0

    await Promise.allSettled(
      allStored.map(async (sf) => {
        try {
          await deleteFile(sf.storagePath)
          deletedPreviewFiles++
        } catch {
          failedPreviewFiles++
        }
      })
    )

    // Delete StoredFile records
    if (videoIds.length > 0) {
      await deleteStoredFilesByCriteria({
        entityType: 'VIDEO', entityIds: videoIds, fileRoles: previewRoles,
      })
    }
    if (assetIds.length > 0) {
      await deleteStoredFilesByCriteria({
        entityType: 'VIDEO_ASSET', entityIds: assetIds, fileRoles: ['PREVIEW_IMAGE', 'PREVIEW_MP4'],
      })
    }

    return NextResponse.json({
      success: true,
      totalProjects: closedProjects.length,
      deletedPreviewFiles,
      failedPreviewFiles,
    })
  } catch (error) {
    console.error('Error deleting closed project previews:', error)
    return NextResponse.json({ error: 'Failed to delete closed project previews' }, { status: 500 })
  }
}
