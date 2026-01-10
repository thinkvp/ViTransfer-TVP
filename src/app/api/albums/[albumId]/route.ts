import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteDirectory, deleteFile } from '@/lib/storage'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// DELETE /api/albums/[albumId] - delete album (admin)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'manageProjectAlbums')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many delete requests. Please slow down.' },
    'album-delete'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { albumId } = await params

    const album = await prisma.album.findUnique({
      where: { id: albumId },
      include: {
        photos: {
          select: { id: true, storagePath: true, socialStoragePath: true },
        },
      },
    })

    if (!album) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

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

    // Best-effort: delete physical files
    for (const photo of album.photos) {
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
          await deleteFile(photo.socialStoragePath).catch(() => {})
        }
      } catch {
        // Ignore storage errors; DB is source of truth
      }
    }

    // Delete DB records (in case cascade isn't configured)
    await prisma.albumPhoto.deleteMany({ where: { albumId } })
    await prisma.album.delete({ where: { id: albumId } })

    // Best-effort: delete album directory (if empty or still present)
    try {
      await deleteDirectory(`projects/${album.projectId}/albums/${album.id}`)
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error deleting album:', error)
    return NextResponse.json({ error: 'Failed to delete album' }, { status: 500 })
  }
}
