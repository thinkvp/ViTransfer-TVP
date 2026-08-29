import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getStoredFileRecords } from '@/lib/stored-file'

export const runtime = 'nodejs'

/**
 * GET /api/projects/[id]/version-assets
 *
 * Per-version asset inventory for one project: what each version holds, so the
 * new-version upload panel can offer "copy assets from earlier versions" without a
 * request per version. Gated on `projectsFullControl` — the same permission the copy
 * itself requires — so it can never advertise files the caller couldn't copy.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'projectsFullControl')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.',
    },
    'project-version-assets'
  )
  if (rateLimitResult) return rateLimitResult

  const { id: projectId } = await params

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        status: true,
        assignedUsers: { select: { userId: true } },
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = project.assignedUsers?.some((u) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      if (!isVisibleProjectStatusForUser(authResult, project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    const videos = await prisma.video.findMany({
      where: { projectId },
      select: { id: true, name: true, version: true, versionLabel: true },
      orderBy: [{ name: 'asc' }, { version: 'desc' }],
    })

    const assets = await prisma.videoAsset.findMany({
      where: { videoId: { in: videos.map((v) => v.id) } },
      select: { id: true, videoId: true, fileName: true, fileType: true, category: true },
      orderBy: { createdAt: 'desc' },
    })

    // Sizes live on the ORIGINAL StoredFile row, not on VideoAsset — one batched read
    // rather than a join per asset.
    const storedSizes = assets.length > 0
      ? await getStoredFileRecords('VIDEO_ASSET', assets.map((a) => a.id), {
          fileRoles: ['ORIGINAL'],
          select: { entityId: true, fileSize: true },
        })
      : []
    const sizeByAssetId = new Map(storedSizes.map((s) => [s.entityId as string, s.fileSize as bigint | null]))

    const assetsByVideo = new Map<string, Array<Record<string, unknown>>>()
    for (const asset of assets) {
      const size = sizeByAssetId.get(asset.id)
      const list = assetsByVideo.get(asset.videoId) ?? []
      list.push({
        id: asset.id,
        fileName: asset.fileName,
        fileType: asset.fileType,
        category: asset.category,
        fileSize: size != null ? String(size) : '0',
      })
      assetsByVideo.set(asset.videoId, list)
    }

    return NextResponse.json({
      videos: videos.map((video) => {
        const videoAssets = assetsByVideo.get(video.id) ?? []
        return {
          ...video,
          assetCount: videoAssets.length,
          assetBytes: String(videoAssets.reduce((sum, a) => sum + Number(a.fileSize || 0), 0)),
          assets: videoAssets,
        }
      }),
    })
  } catch (error) {
    console.error('Error listing version assets:', error)
    return NextResponse.json({ error: 'Failed to list version assets' }, { status: 500 })
  }
}
