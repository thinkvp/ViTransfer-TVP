import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { deleteFile } from '@/lib/storage'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { z } from 'zod'
export const runtime = 'nodejs'

const deletePreviewsSchema = z.object({
  resolutions: z.array(z.enum(['480p', '720p', '1080p'])).min(1),
})

const RESOLUTION_TO_FIELD = {
  '480p': 'preview480Path',
  '720p': 'preview720Path',
  '1080p': 'preview1080Path',
} as const

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectStatuses')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: 'Too many requests. Please slow down.',
  }, 'project-delete-previews')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params
    const body = await request.json().catch(() => ({}))
    const parsed = deletePreviewsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const { resolutions } = parsed.data

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { videos: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    let deletedCount = 0

    for (const video of project.videos) {
      const filesToDelete: string[] = []
      const dbUpdate: Record<string, null> = {}

      for (const res of resolutions) {
        const field = RESOLUTION_TO_FIELD[res]
        const path = (video as any)[field]
        if (path) {
          filesToDelete.push(path)
          dbUpdate[field] = null
        }
      }

      if (filesToDelete.length > 0) {
        await Promise.allSettled(filesToDelete.map(f => deleteFile(f)))
        await prisma.video.update({
          where: { id: video.id },
          data: dbUpdate,
        })
        deletedCount += filesToDelete.length
      }
    }

    return NextResponse.json({
      success: true,
      deletedCount,
    })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete previews' }, { status: 500 })
  }
}
