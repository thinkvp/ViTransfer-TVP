import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { albumZipExists, getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { getAlbumPhotoZipQueue } from '@/lib/queue'

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

  const projectStoragePath = album.project.storagePath
    || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
  const albumFolderName = album.storageFolderName || album.name

  const fullZipStoragePath = getAlbumZipStoragePath({
    projectStoragePath,
    albumFolderName,
    albumName: album.name,
    variant: 'full',
  })
  const socialZipStoragePath = getAlbumZipStoragePath({
    projectStoragePath,
    albumFolderName,
    albumName: album.name,
    variant: 'social',
  })

  const [fullExists, socialExists] = await Promise.all([
    albumZipExists(fullZipStoragePath),
    album.socialCopiesEnabled ? albumZipExists(socialZipStoragePath) : Promise.resolve(false),
  ])

  let fullZipQueuedOrActive = false
  let socialZipQueuedOrActive = false
  try {
    const zipQueue = getAlbumPhotoZipQueue()
    const fullJobId = getAlbumZipJobId({ albumId, variant: 'full' })
    const socialJobId = getAlbumZipJobId({ albumId, variant: 'social' })

    const [fullJob, socialJob] = await Promise.all([
      zipQueue.getJob(fullJobId),
      zipQueue.getJob(socialJobId),
    ])

    const pendingStates = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])

    const [fullState, socialState] = await Promise.all([
      fullJob ? fullJob.getState().catch(() => null) : Promise.resolve(null),
      socialJob ? socialJob.getState().catch(() => null) : Promise.resolve(null),
    ])

    fullZipQueuedOrActive = Boolean(fullState && pendingStates.has(fullState))
    socialZipQueuedOrActive = Boolean(socialState && pendingStates.has(socialState))
  } catch {
    // If queue state cannot be read, fall back to file-existence readiness only.
  }

  const fullReady = fullExists && !fullZipQueuedOrActive
  const socialReady = album.socialCopiesEnabled && socialExists && !socialZipQueuedOrActive

  return NextResponse.json({
    zip: {
      fullReady,
      socialReady,
    },
  })
}
