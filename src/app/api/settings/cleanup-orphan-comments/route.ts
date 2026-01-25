import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { deleteFile } from '@/lib/storage'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'

type OrphanRow = {
  id: string
  projectId: string
  videoId: string
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  // Keep this allow-listed under an existing "dangerous" settings action.
  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 10,
      message: 'Too many requests. Please slow down.',
    },
    'cleanup-orphan-comments'
  )
  if (rateLimitResult) return rateLimitResult

  let dryRun = true
  let limit = 5000

  try {
    const body = await request.json().catch(() => ({}))
    dryRun = body?.dryRun !== false
    if (typeof body?.limit === 'number' && Number.isFinite(body.limit)) {
      limit = Math.max(1, Math.min(20000, Math.floor(body.limit)))
    }
  } catch {
    // ignore; defaults apply
  }

  // Find comments whose linked video no longer exists.
  // Comment.videoId is not a FK (historical), so we use a LEFT JOIN.
  const orphanComments = await prisma.$queryRaw<OrphanRow[]>`
    SELECT c.id, c."projectId", c."videoId"
    FROM "Comment" c
    LEFT JOIN "Video" v ON v.id = c."videoId"
    WHERE v.id IS NULL
    ORDER BY c."createdAt" DESC
    LIMIT ${limit}
  `

  const orphanCommentIds = orphanComments.map((c) => c.id)
  const sample = {
    commentIds: orphanCommentIds.slice(0, 10),
    projectIds: Array.from(new Set(orphanComments.map((c) => c.projectId))).slice(0, 10),
    videoIds: Array.from(new Set(orphanComments.map((c) => c.videoId))).slice(0, 10),
  }

  if (orphanCommentIds.length === 0) {
    return NextResponse.json({
      ok: true,
      dryRun,
      limit,
      orphanComments: 0,
      orphanCommentFiles: 0,
      orphanCommentFileBytes: 0,
      uniqueStoragePaths: 0,
      sample,
      deleted: dryRun ? undefined : { comments: 0, filesDeleted: 0, filesFailed: 0 },
    })
  }

  const orphanFiles = await prisma.commentFile.findMany({
    where: { commentId: { in: orphanCommentIds } },
    select: { id: true, storagePath: true, fileSize: true },
  })

  const uniquePaths = Array.from(new Set(orphanFiles.map((f) => f.storagePath)))
  const orphanBytes = orphanFiles.reduce((acc, f) => acc + Number(f.fileSize), 0)

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      limit,
      orphanComments: orphanCommentIds.length,
      orphanCommentFiles: orphanFiles.length,
      orphanCommentFileBytes: orphanBytes,
      uniqueStoragePaths: uniquePaths.length,
      sample,
    })
  }

  // Execute cleanup: best-effort delete files, then delete comments.
  const fileIdsToDelete = new Set(orphanFiles.map((f) => f.id))
  let filesDeleted = 0
  let filesFailed = 0
  const errors: Array<{ storagePath: string; error: string }> = []

  for (const storagePath of uniquePaths) {
    try {
      // Only delete if no other CommentFile row references the same storagePath
      // outside of the set we are about to cascade-delete.
      const sharedCount = await prisma.commentFile.count({
        where: {
          storagePath,
          id: { notIn: Array.from(fileIdsToDelete) },
        },
      })

      if (sharedCount === 0) {
        await deleteFile(storagePath)
        filesDeleted++
      }
    } catch (e: any) {
      filesFailed++
      errors.push({ storagePath, error: String(e?.message || e) })
    }
  }

  const deleteResult = await prisma.comment.deleteMany({
    where: { id: { in: orphanCommentIds } },
  })

  return NextResponse.json({
    ok: true,
    dryRun: false,
    limit,
    orphanComments: orphanCommentIds.length,
    orphanCommentFiles: orphanFiles.length,
    orphanCommentFileBytes: orphanBytes,
    uniqueStoragePaths: uniquePaths.length,
    sample,
    deleted: {
      comments: deleteResult.count,
      filesDeleted,
      filesFailed,
    },
    errors: errors.length ? errors.slice(0, 50) : undefined,
  })
}
