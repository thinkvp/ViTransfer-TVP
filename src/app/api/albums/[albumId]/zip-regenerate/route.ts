import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile } from '@/lib/storage'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { syncAlbumZipSizes } from '@/lib/album-zip-size-sync'
import { isDropboxStorageConfigured, deleteDropboxFile } from '@/lib/storage-provider-dropbox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/albums/[albumId]/zip-regenerate (admin)
export async function POST(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'manageProjectAlbums')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'album-zip-regenerate'
  )
  if (rateLimitResult) return rateLimitResult

  const { albumId } = await params

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      projectId: true,
      name: true,
      storageFolderName: true,
      socialCopiesEnabled: true,
      dropboxEnabled: true,
      fullZipDropboxPath: true,
      socialZipDropboxPath: true,
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

  if (!album) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  // Immediately reflect that background work is required.
  await prisma.album.update({
    where: { id: album.id },
    data: { status: 'PROCESSING' },
  }).catch(() => {})

  if (auth.appRoleIsSystemAdmin !== true) {
    const project = await prisma.project.findUnique({
      where: { id: album.projectId },
      select: { status: true, assignedUsers: { select: { userId: true } } },
    })

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const assigned = project.assignedUsers?.some((u) => u.userId === auth.id)
    if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (!isVisibleProjectStatusForUser(auth, project.status)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const projectStoragePath = album.project.storagePath
    || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
  const albumFolderName = album.storageFolderName || album.name

  const fullZipPath = getAlbumZipStoragePath({
    projectStoragePath,
    albumFolderName,
    albumName: album.name,
    variant: 'full',
  })

  await deleteFile(fullZipPath).catch(() => {})

  if (album.socialCopiesEnabled) {
    const socialZipPath = getAlbumZipStoragePath({
      projectStoragePath,
      albumFolderName,
      albumName: album.name,
      variant: 'social',
    })
    await deleteFile(socialZipPath).catch(() => {})
  }

  // Delete Dropbox copies if they exist and reset tracking so re-upload queues after new ZIPs are ready.
  if (album.dropboxEnabled) {
    const dropboxPaths = [
      album.fullZipDropboxPath,
      ...(album.socialCopiesEnabled ? [album.socialZipDropboxPath] : []),
    ].filter(Boolean) as string[]
    if (isDropboxStorageConfigured()) {
      await Promise.allSettled(dropboxPaths.map((p) => deleteDropboxFile('', p).catch(() => {})))
    }
    await prisma.album.update({
      where: { id: album.id },
      data: {
        fullZipDropboxStatus: null,
        fullZipDropboxProgress: 0,
        fullZipDropboxError: null,
        fullZipDropboxPath: null,
        ...(album.socialCopiesEnabled ? {
          socialZipDropboxStatus: null,
          socialZipDropboxProgress: 0,
          socialZipDropboxError: null,
          socialZipDropboxPath: null,
        } : {}),
      },
    }).catch(() => {})
  }

  // Keep DB totals consistent with storage after invalidation.
  await syncAlbumZipSizes({ albumId: album.id, projectId: album.projectId }).catch(() => {})

  try {
    const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
    const q = getAlbumPhotoZipQueue()

    const fullJobId = getAlbumZipJobId({ albumId: album.id, variant: 'full' })
    await q.remove(fullJobId).catch(() => {})
    await q.add('generate-album-zip', { albumId: album.id, variant: 'full' }, { jobId: fullJobId }).catch(() => {})

    if (album.socialCopiesEnabled) {
      const socialJobId = getAlbumZipJobId({ albumId: album.id, variant: 'social' })
      await q.remove(socialJobId).catch(() => {})
      await q.add('generate-album-zip', { albumId: album.id, variant: 'social' }, { jobId: socialJobId }).catch(() => {})
    }
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true })
}
