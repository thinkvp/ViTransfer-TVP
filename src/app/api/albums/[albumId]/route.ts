import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteDirectory, deleteFile, moveDirectory } from '@/lib/storage'
import { isVisibleProjectStatusForUser, requireActionAccess, requireAnyActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import {
  allocateUniqueStorageName,
  buildAlbumDropboxRoot,
  buildAlbumStorageRoot,
  buildProjectStorageRoot,
  getStoragePathBasename,
  replaceStoredStoragePathPrefix,
} from '@/lib/project-storage-paths'
import { moveDropboxPath } from '@/lib/storage-provider-dropbox'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateAlbumSchema = z.object({
  name: z.string().min(1).max(200).optional(),
})

// PATCH /api/albums/[albumId] - update album (admin)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  // Allow both album managers and full-control project admins to rename albums.
  const forbiddenAction = requireAnyActionAccess(auth, ['manageProjectAlbums', 'projectsFullControl'])
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many update requests. Please slow down.' },
    'album-update'
  )
  if (rateLimitResult) return rateLimitResult

  const { albumId } = await params

  const body = await request.json().catch(() => null)
  const parsed = updateAlbumSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      projectId: true,
      name: true,
      storageFolderName: true,
      dropboxEnabled: true,
      fullZipDropboxPath: true,
      socialZipDropboxPath: true,
      project: { select: { title: true, companyName: true, storagePath: true, client: { select: { name: true } } } },
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

  const data: any = {}
  let albumRenamePlan: null | {
    oldAlbumStorageRoot: string
    newAlbumStorageRoot: string
  } = null

  if (typeof parsed.data.name === 'string') {
    const trimmed = parsed.data.name.trim()
    if (!trimmed) {
      return NextResponse.json({ error: 'Album name cannot be empty' }, { status: 400 })
    }
    data.name = trimmed

    if (trimmed !== album.name) {
      const siblingAlbums = await prisma.album.findMany({
        where: { projectId: album.projectId, NOT: { id: albumId } },
        select: { storageFolderName: true, name: true },
      })
      const newAlbumFolderName = allocateUniqueStorageName(
        trimmed,
        siblingAlbums.map((row) => row.storageFolderName || row.name).filter(Boolean) as string[],
      )
      const projectStoragePath = album.project.storagePath
        || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
      const oldAlbumStorageRoot = buildAlbumStorageRoot(
        projectStoragePath,
        album.storageFolderName || album.name,
      )
      const newAlbumStorageRoot = buildAlbumStorageRoot(projectStoragePath, newAlbumFolderName)
      data.storageFolderName = newAlbumFolderName

      if (oldAlbumStorageRoot !== newAlbumStorageRoot) {
        albumRenamePlan = { oldAlbumStorageRoot, newAlbumStorageRoot }
      }
    }
  }

  if (albumRenamePlan) {
    await moveDirectory(albumRenamePlan.oldAlbumStorageRoot, albumRenamePlan.newAlbumStorageRoot)
  }

  // Return a JSON-safe subset (some Album fields are BigInt and would break JSON serialization)
  const updated = await prisma.$transaction(async (tx) => {
    const updatedAlbum = await tx.album.update({
      where: { id: albumId },
      data,
      select: {
        id: true,
        projectId: true,
        name: true,
        notes: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (albumRenamePlan) {
      const photos = await tx.albumPhoto.findMany({
        where: { albumId },
        select: { id: true, storagePath: true, socialStoragePath: true },
      })
      for (const photo of photos) {
        await tx.albumPhoto.update({
          where: { id: photo.id },
          data: {
            storagePath: replaceStoredStoragePathPrefix(
              photo.storagePath,
              albumRenamePlan.oldAlbumStorageRoot,
              albumRenamePlan.newAlbumStorageRoot,
            )!,
            socialStoragePath: replaceStoredStoragePathPrefix(
              photo.socialStoragePath,
              albumRenamePlan.oldAlbumStorageRoot,
              albumRenamePlan.newAlbumStorageRoot,
            ),
          },
        })
      }
    }

    return updatedAlbum
  })

  // Rename Dropbox folder when album name changes
  if (data.name && data.name !== album.name && album.dropboxEnabled) {
    const clientName = album.project.client?.name || album.project.companyName || 'Client'
    const projectFolderName = getStoragePathBasename(album.project.storagePath) || album.project.title
    const oldAlbumFolder = buildAlbumDropboxRoot(clientName, projectFolderName, album.name)
    const newAlbumFolder = buildAlbumDropboxRoot(clientName, projectFolderName, data.name)
    if (oldAlbumFolder !== newAlbumFolder) {
      void moveDropboxPath(oldAlbumFolder, newAlbumFolder).catch(() => {})
      // Update stored album ZIP dropbox paths
      const pathData: Record<string, string> = {}
      if (album.fullZipDropboxPath?.startsWith(oldAlbumFolder + '/')) {
        pathData.fullZipDropboxPath = newAlbumFolder + album.fullZipDropboxPath.slice(oldAlbumFolder.length)
      }
      if (album.socialZipDropboxPath?.startsWith(oldAlbumFolder + '/')) {
        pathData.socialZipDropboxPath = newAlbumFolder + album.socialZipDropboxPath.slice(oldAlbumFolder.length)
      }
      if (Object.keys(pathData).length > 0) {
        await prisma.album.update({ where: { id: albumId }, data: pathData })
      }
    }
  }

  return NextResponse.json({ album: updated })
}

// DELETE /api/albums/[albumId] - delete album (admin)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'projectsFullControl')
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
        project: {
          select: {
            storagePath: true,
            title: true,
            companyName: true,
            client: { select: { name: true } },
          },
        },
        photos: {
          select: { id: true, fileSize: true, socialFileSize: true, storagePath: true, socialStoragePath: true },
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

    const photosDelta = album.photos.reduce((acc, p) => acc + p.fileSize + p.socialFileSize, BigInt(0))
    const zipDelta = (album.fullZipFileSize ?? BigInt(0)) + (album.socialZipFileSize ?? BigInt(0))
    await adjustProjectTotalBytes(album.projectId, (photosDelta + zipDelta) * BigInt(-1))

    // Best-effort: delete album directory (if empty or still present)
    try {
      const projectStoragePath = album.project.storagePath
        || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
      await deleteDirectory(
        buildAlbumStorageRoot(
          projectStoragePath,
          album.storageFolderName || album.name || album.id,
        )
      )
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error deleting album:', error)
    return NextResponse.json({ error: 'Failed to delete album' }, { status: 500 })
  }
}
