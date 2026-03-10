import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { getVideoQueue } from '@/lib/queue'
import { deleteFile } from '@/lib/storage'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { z } from 'zod'
export const runtime = 'nodejs'

const VALID_RESOLUTIONS = ['480p', '720p', '1080p'] as const




const reprocessSchema = z.object({
  videoIds: z.array(z.string().min(1)).max(50).optional(),
  previewResolutions: z.array(z.enum(VALID_RESOLUTIONS)).min(1).optional(),
  regenerateThumbnail: z.boolean().optional(),
  regenerateTimelinePreviews: z.boolean().optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Check authentication - only admins can reprocess
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectStatuses')
  if (forbiddenAction) return forbiddenAction

  // Rate limit to avoid enqueue abuse
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: 'Too many reprocess requests. Please slow down.',
  }, 'project-reprocess')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params
    const body = await request.json().catch(() => ({}))
    const parsed = reprocessSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const {
      videoIds,
      previewResolutions,
      regenerateThumbnail,
      regenerateTimelinePreviews,
    } = parsed.data

    // Get project with videos
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        videos: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (project.status === 'CLOSED') {
      return NextResponse.json(
        { error: 'Closed projects cannot queue preview regeneration jobs.' },
        { status: 409 }
      )
    }

    // Filter videos: only READY or ERROR status
    let videosToReprocess = project.videos.filter(
      video => video.status === 'READY' || video.status === 'ERROR'
    )

    // If videoIds array provided, filter to only those specific videos
    if (videoIds && Array.isArray(videoIds) && videoIds.length > 0) {
      videosToReprocess = videosToReprocess.filter(video => videoIds.includes(video.id))
    }

    if (videosToReprocess.length === 0) {
      return NextResponse.json({
        error: 'No videos available for reprocessing',
      }, { status: 400 })
    }

    const videoQueue = getVideoQueue()
    const reprocessed = []
    const targetedPreviewGeneration = Array.isArray(previewResolutions) && previewResolutions.length > 0

    for (const video of videosToReprocess) {
      // Preserve user-uploaded thumbnails (asset-based) so reprocessing doesn't delete them
      const hasCustomThumbnail = video.thumbnailPath
        ? !!(await prisma.videoAsset.findFirst({
            where: {
              videoId: video.id,
              storagePath: video.thumbnailPath,
            },
            select: { id: true },
          })) || video.thumbnailPath.includes('/videos/assets/')
        : false

      // Delete old preview files (keep original safe)
      const previewFieldsByResolution = {
        '480p': video.preview480Path,
        '720p': video.preview720Path,
        '1080p': video.preview1080Path,
      } as const

      const filesToDelete = [
        ...(targetedPreviewGeneration
          ? previewResolutions.map((resolution) => previewFieldsByResolution[resolution]).filter(Boolean)
          : [video.preview480Path, video.preview720Path, video.preview1080Path]),
        // Only delete system-generated thumbnails; keep custom assets intact
        (!targetedPreviewGeneration && !hasCustomThumbnail) || regenerateThumbnail === true
          ? (hasCustomThumbnail ? null : video.thumbnailPath)
          : null,
      ].filter(Boolean) as string[]

      await Promise.allSettled(
        filesToDelete.map(filePath => deleteFile(filePath))
      )

      // Reset video status and clear preview paths.
      // Use QUEUED (not PROCESSING) so the worker advances the status
      // when it actually picks up the job — matching the upload flow.
      await prisma.video.update({
        where: { id: video.id },
        data: {
          status: 'QUEUED',
          processingProgress: 0,
          processingPhase: null,
          ...(targetedPreviewGeneration
            ? {
                ...(previewResolutions.includes('480p') ? { preview480Path: null } : {}),
                ...(previewResolutions.includes('720p') ? { preview720Path: null } : {}),
                ...(previewResolutions.includes('1080p') ? { preview1080Path: null } : {}),
              }
            : {
                preview480Path: null,
                preview720Path: null,
                preview1080Path: null,
              }),
          ...((regenerateThumbnail === true || !targetedPreviewGeneration)
            ? {
                // Keep custom thumbnails; regenerate only system thumbnails
                thumbnailPath: hasCustomThumbnail ? video.thumbnailPath : null,
              }
            : {}),
        },
      })

      // Re-queue video for processing
      await videoQueue.add('process-video', {
        videoId: video.id,
        originalStoragePath: video.originalStoragePath,
        projectId: project.id,
        ...(targetedPreviewGeneration ? { requestedPreviewResolutions: previewResolutions } : {}),
        ...(regenerateThumbnail !== undefined ? { regenerateThumbnail } : {}),
        ...(regenerateTimelinePreviews !== undefined ? { regenerateTimelinePreviews } : {}),
      })

      reprocessed.push({
        id: video.id,
        name: video.name,
        versionLabel: video.versionLabel,
      })
    }

    return NextResponse.json({
      success: true,
      count: reprocessed.length,
      videos: reprocessed,
    })
  } catch (error) {
    console.error('Error reprocessing videos:', error)
    return NextResponse.json(
      { error: 'Failed to reprocess videos' },
      { status: 500 }
    )
  }
}
