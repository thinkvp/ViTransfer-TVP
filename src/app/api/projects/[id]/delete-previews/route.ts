import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { deleteFile } from '@/lib/storage'
import { deleteStoredFilesByCriteria, getStoredFileRecords, RESOLUTION_TO_FILE_ROLE, type FileRole } from '@/lib/stored-file'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { deleteProjectPreviews } from '@/lib/delete-project-previews'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { z } from 'zod'
export const runtime = 'nodejs'

const deletePreviewsSchema = z.union([
  // Delete the MP4 previews for specific resolutions (used when a resolution is
  // removed from the project's preview settings).
  z.object({
    resolutions: z.array(z.enum(['480p', '720p', '1080p'])).min(1),
  }),
  // Delete every playable rendition (MP4 previews + asset playback MP4s + HLS
  // bundles) to free storage — same set the auto-delete-on-close path sheds.
  // Only allowed on CLOSED projects; reopening regenerates playback.
  z.object({
    scope: z.literal('all'),
  }),
])

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
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
    }

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

    if ('scope' in parsed.data) {
      if (project.status !== 'CLOSED') {
        return NextResponse.json(
          { error: 'Previews can only be deleted for closed projects' },
          { status: 409 }
        )
      }
      const result = await deleteProjectPreviews(projectId, { logPrefix: 'DELETE-PREVIEWS' })
      return NextResponse.json({ success: true, ...result })
    }

    const { resolutions } = parsed.data

    let deletedCount = 0
    const videoIdsToCleanup: string[] = []
    const rolesToCleanup: FileRole[] = resolutions.map(r => RESOLUTION_TO_FILE_ROLE[r])

    for (const video of project.videos) {
      // Resolve preview file paths from the StoredFile registry. The legacy *Path
      // columns were dropped, so the registry is the only source of truth here.
      const stored = await getStoredFileRecords('VIDEO', [video.id], {
        fileRoles: rolesToCleanup,
        select: { storagePath: true },
      }) as Array<{ storagePath: string | null }>
      const filesToDelete = stored
        .map(s => s.storagePath)
        .filter((p): p is string => !!p)

      if (filesToDelete.length > 0) {
        await Promise.allSettled(filesToDelete.map(f => deleteFile(f)))
        videoIdsToCleanup.push(video.id)
        deletedCount += filesToDelete.length
      }
    }

    // Clean up StoredFile rows for deleted previews, then refresh project totals.
    if (videoIdsToCleanup.length > 0) {
      await deleteStoredFilesByCriteria({
        entityType: 'VIDEO',
        entityIds: videoIdsToCleanup,
        fileRoles: rolesToCleanup,
      }).catch(() => {})
      await recalculateAndStoreProjectTotalBytes(projectId).catch(() => {})
    }

    return NextResponse.json({
      success: true,
      deletedCount,
    })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete previews' }, { status: 500 })
  }
}
