import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { getVideoQueue } from '@/lib/queue'
import { deleteDirectory } from '@/lib/storage'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { z } from 'zod'

export const runtime = 'nodejs'

const bodySchema = z.object({
  action: z.enum(['remove', 'generate']),
})

/**
 * Manage timeline previews for all videos in a project.
 *
 * - `action: 'remove'`   — delete sprite files from storage and clear DB fields.
 * - `action: 'generate'` — queue timeline-only worker jobs for every READY video
 *                           that doesn't already have previews generated.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: 'Too many timeline preview requests. Please slow down.',
  }, 'timeline-previews')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params
    const body = await request.json().catch(() => ({}))
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }

    const { action } = parsed.data

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, status: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (project.status === 'CLOSED' && action === 'generate') {
      return NextResponse.json(
        { error: 'Closed projects cannot queue timeline preview generation jobs.' },
        { status: 409 }
      )
    }

    if (action === 'remove') {
      // Find all videos that have timeline previews
      const videosWithPreviews = await prisma.video.findMany({
        where: {
          projectId,
          timelinePreviewsReady: true,
        },
        select: {
          id: true,
          timelinePreviewSpritesPath: true,
        },
      })

      // Delete sprite directories from storage
      const deletions = videosWithPreviews
        .filter(v => v.timelinePreviewSpritesPath)
        .map(v => deleteDirectory(v.timelinePreviewSpritesPath!).catch(err => {
          console.error(`[TIMELINE] Failed to delete sprites for video ${v.id}:`, err)
        }))

      await Promise.allSettled(deletions)

      // Clear DB fields for all project videos
      await prisma.video.updateMany({
        where: { projectId },
        data: {
          timelinePreviewsReady: false,
          timelinePreviewVttPath: null,
          timelinePreviewSpritesPath: null,
        },
      })

      return NextResponse.json({
        success: true,
        action: 'remove',
        count: videosWithPreviews.length,
      })
    }

    // action === 'generate'
    const readyVideos = await prisma.video.findMany({
      where: {
        projectId,
        status: 'READY',
        timelinePreviewsReady: false,
      },
      select: {
        id: true,
        originalStoragePath: true,
        name: true,
        versionLabel: true,
      },
    })

    if (readyVideos.length === 0) {
      return NextResponse.json({
        success: true,
        action: 'generate',
        count: 0,
        message: 'No videos need timeline preview generation',
      })
    }

    const videoQueue = getVideoQueue()

    for (const video of readyVideos) {
      // Mark the video so it appears in Running Jobs while staying READY for viewing.
      // If queueing fails, immediately clear the marker so it does not get stuck.
      await prisma.video.update({
        where: { id: video.id },
        data: { processingPhase: 'timeline', processingProgress: 0 },
      })

      try {
        await videoQueue.add('process-video', {
          videoId: video.id,
          originalStoragePath: video.originalStoragePath,
          projectId,
          timelineOnly: true,
        })
      } catch (error) {
        await prisma.video.update({
          where: { id: video.id },
          data: { processingPhase: null, processingProgress: 0 },
        }).catch(() => {})
        throw error
      }
    }

    return NextResponse.json({
      success: true,
      action: 'generate',
      count: readyVideos.length,
      videos: readyVideos.map(v => ({
        id: v.id,
        name: v.name,
        versionLabel: v.versionLabel,
      })),
    })
  } catch (error) {
    console.error('[TIMELINE] Error managing timeline previews:', error)
    return NextResponse.json(
      { error: 'Failed to manage timeline previews' },
      { status: 500 }
    )
  }
}
