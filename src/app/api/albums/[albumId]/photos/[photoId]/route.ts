import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile } from '@/lib/storage'
import { getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// DELETE /api/albums/[albumId]/photos/[photoId] - delete photo (admin)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ albumId: string; photoId: string }> }
) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

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
      select: { id: true, storagePath: true, socialStoragePath: true, album: { select: { projectId: true } } },
    })

    if (!photo) return NextResponse.json({ error: 'Photo not found' }, { status: 404 })

    await prisma.albumPhoto.delete({ where: { id: photoId } })

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
      const fullZipPath = getAlbumZipStoragePath({ projectId: photo.album.projectId, albumId, variant: 'full' })
      const socialZipPath = getAlbumZipStoragePath({ projectId: photo.album.projectId, albumId, variant: 'social' })

      await deleteFile(fullZipPath).catch(() => {})
      await deleteFile(socialZipPath).catch(() => {})

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
