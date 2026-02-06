import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile } from '@/lib/storage'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { syncAlbumZipSizes } from '@/lib/album-zip-size-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/albums/[albumId]/photos/[photoId] - check if photo exists (admin)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ albumId: string; photoId: string }> }
) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const { albumId, photoId } = await params

  const photo = await prisma.albumPhoto.findFirst({
    where: { id: photoId, albumId },
    select: { id: true, status: true },
  })

  if (!photo) return NextResponse.json({ error: 'Photo not found' }, { status: 404 })
  return NextResponse.json({ id: photo.id, status: photo.status })
}

// DELETE /api/albums/[albumId]/photos/[photoId] - delete photo (admin)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ albumId: string; photoId: string }> }
) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'projectsFullControl')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many delete requests. Please slow down.' },
    'album-photo-delete'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { albumId, photoId } = await params

    const photo = await prisma.albumPhoto.findFirst({
      where: { id: photoId, albumId },
      select: {
        id: true,
        fileSize: true,
        socialFileSize: true,
        storagePath: true,
        socialStoragePath: true,
        album: { select: { projectId: true } },
      },
    })

    if (!photo) return NextResponse.json({ error: 'Photo not found' }, { status: 404 })

    if (auth.appRoleIsSystemAdmin !== true) {
      const project = await prisma.project.findUnique({
        where: { id: photo.album.projectId },
        select: { status: true, assignedUsers: { select: { userId: true } } },
      })

      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

      const assigned = project.assignedUsers?.some((u) => u.userId === auth.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(auth, project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    await prisma.albumPhoto.delete({ where: { id: photoId } })

    await adjustProjectTotalBytes(photo.album.projectId, (photo.fileSize + photo.socialFileSize) * BigInt(-1))

    try {
      const sharedCount = await prisma.albumPhoto.count({
        where: {
          storagePath: photo.storagePath,
          id: { not: photo.id },
        },
      })

      if (sharedCount === 0) {
        await deleteFile(photo.storagePath)
      }

      if (photo.socialStoragePath) {
        // Social derivatives are not shared across records today; delete best-effort.
        await deleteFile(photo.socialStoragePath).catch(() => {})
      }
    } catch {
      // Ignore storage delete errors; DB is source of truth.
    }

    // Invalidate and (debounced) regenerate album ZIPs
    try {
      await prisma.album.update({
        where: { id: albumId },
        data: { status: 'PROCESSING' },
      }).catch(() => {})

      const fullZipPath = getAlbumZipStoragePath({ projectId: photo.album.projectId, albumId, variant: 'full' })
      const socialZipPath = getAlbumZipStoragePath({ projectId: photo.album.projectId, albumId, variant: 'social' })

      await deleteFile(fullZipPath).catch(() => {})
      await deleteFile(socialZipPath).catch(() => {})

      await syncAlbumZipSizes({ albumId, projectId: photo.album.projectId }).catch(() => {})

      const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
      const q = getAlbumPhotoZipQueue()
      const delayMs = 10_000

      const fullJobId = getAlbumZipJobId({ albumId, variant: 'full' })
      const socialJobId = getAlbumZipJobId({ albumId, variant: 'social' })

      await q.remove(fullJobId).catch(() => {})
      await q.remove(socialJobId).catch(() => {})

      await q.add('generate-album-zip', { albumId, variant: 'full' }, { jobId: fullJobId, delay: delayMs }).catch(() => {})
      await q.add('generate-album-zip', { albumId, variant: 'social' }, { jobId: socialJobId, delay: delayMs }).catch(() => {})
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error deleting album photo:', error)
    return NextResponse.json({ error: 'Failed to delete photo' }, { status: 500 })
  }
}
