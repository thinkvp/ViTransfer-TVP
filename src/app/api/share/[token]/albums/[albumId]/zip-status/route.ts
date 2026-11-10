import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { getAlbumZipReadiness } from '@/lib/album-share'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/share/[token]/albums/[albumId]/zip-status - lightweight ZIP readiness
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; albumId: string }> }
) {
  const { token, albumId } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    `share-album-zip-status:${token}:${albumId}`
  )
  if (rateLimitResult) return rateLimitResult

  const projectMeta = await prisma.project.findUnique({
    where: { slug: token },
    select: { id: true, sharePassword: true, authMode: true, enablePhotos: true },
  })

  if (!projectMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (projectMeta.enablePhotos === false) {
    return NextResponse.json({ error: 'Album not found' }, { status: 404 })
  }

  const accessCheck = await verifyProjectAccess(request, projectMeta.id, projectMeta.sharePassword, projectMeta.authMode, {
    allowAnonymousNone: true,
  })

  if (!accessCheck.authorized) {
    return accessCheck.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      projectId: true,
      name: true,
      storageFolderName: true,
      socialCopiesEnabled: true,
      project: {
        select: {
          storagePath: true,
          title: true,
          companyName: true,
          client: { select: { name: true } },
        },
      },
    },
  })

  if (!album || album.projectId !== projectMeta.id) {
    return NextResponse.json({ error: 'Album not found' }, { status: 404 })
  }

  const { fullReady, socialReady } = await getAlbumZipReadiness(album, { includeQueueState: true })

  return NextResponse.json({
    zip: {
      fullReady,
      socialReady,
    },
  })
}
