import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteDirectory, deleteFile, moveDirectory, moveFile } from '@/lib/storage'
import { renameStoredPaths } from '@/lib/stored-file'
import { isS3Mode } from '@/lib/s3-storage'
import { getFolderRenameQueue } from '@/lib/queue'
import { isVisibleProjectStatusForUser, requireActionAccess, requireAnyActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import {
  allocateUniqueStorageName,
  buildAlbumStorageRoot,
  buildAlbumZipStoragePath,
  buildProjectPreviewsRoot,
  buildProjectStorageRoot,
  replaceStoredStoragePathPrefix,
} from '@/lib/project-storage-paths'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateAlbumSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  confirmed: z.boolean().optional(),
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
    oldAlbumPreviewsRoot: string
    newAlbumPreviewsRoot: string
    newAlbumFolderName: string
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
      const projectPreviewsRoot = buildProjectPreviewsRoot(projectStoragePath)
      // Derive the sanitized folder name from the already-computed storage roots
      const oldSanitizedAlbumFolder = oldAlbumStorageRoot.slice(oldAlbumStorageRoot.lastIndexOf('/') + 1)
      const newSanitizedAlbumFolder = newAlbumStorageRoot.slice(newAlbumStorageRoot.lastIndexOf('/') + 1)
      const oldAlbumPreviewsRoot = `${projectPreviewsRoot}/albums/${oldSanitizedAlbumFolder}`
      const newAlbumPreviewsRoot = `${projectPreviewsRoot}/albums/${newSanitizedAlbumFolder}`
      data.storageFolderName = newAlbumFolderName

      if (oldAlbumStorageRoot !== newAlbumStorageRoot) {
        albumRenamePlan = { oldAlbumStorageRoot, newAlbumStorageRoot, oldAlbumPreviewsRoot, newAlbumPreviewsRoot, newAlbumFolderName }
      }
    }
  }

  if (albumRenamePlan) {
    if (isS3Mode()) {
      // In S3 mode, schedule a background job; paths will be updated by the worker.
      const activeRenameJob = await prisma.folderRenameJob.findFirst({
        where: { entityType: 'ALBUM', entityId: albumId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      })
      if (activeRenameJob) {
        return NextResponse.json(
          { error: 'A folder rename is already in progress for this album. Please wait for it to complete.' },
          { status: 423 },
        )
      }

      if (!parsed.data.confirmed) {
        return NextResponse.json(
          {
            requiresJobConfirmation: true,
            proposedName: albumRenamePlan.newAlbumFolderName,
          },
          { status: 202 },
        )
      }

      // User confirmed — create the background job. The worker will move both the main
      // album folder and its .previews mirror, then update all DB path columns.
      // Clear storageFolderName from the inline data update — the worker sets it via raw SQL.
      delete data.storageFolderName
      const folderRenameJob = await prisma.folderRenameJob.create({
        data: {
          entityType: 'ALBUM',
          entityId: albumId,
          entityName: albumRenamePlan.newAlbumFolderName,
          // Store the current album display name so the worker can rename zip files
          // (e.g. "Old Name Full Res.zip" → "New Name Full Res.zip") after the folder move.
          oldEntityName: album.name,
          oldPrefix: albumRenamePlan.oldAlbumStorageRoot,
          newPrefix: albumRenamePlan.newAlbumStorageRoot,
          status: 'PENDING',
        },
      })
      await getFolderRenameQueue().add('folder-rename', { folderRenameJobId: folderRenameJob.id })
    } else {
      // Local mode: move both the main album folder and its .previews mirror.
      await moveDirectory(albumRenamePlan.oldAlbumStorageRoot, albumRenamePlan.newAlbumStorageRoot)
      await moveDirectory(albumRenamePlan.oldAlbumPreviewsRoot, albumRenamePlan.newAlbumPreviewsRoot)

      // Rename the zip files inside the (now-moved) zips/ subdirectory.
      // The zip filename encodes the album display name, so a folder move alone is not enough.
      const projectStoragePath = album.project.storagePath
        || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
      for (const variant of ['full', 'social'] as const) {
        const oldZipPath = buildAlbumZipStoragePath(projectStoragePath, albumRenamePlan.newAlbumFolderName, album.name, variant)
        const newZipPath = buildAlbumZipStoragePath(projectStoragePath, albumRenamePlan.newAlbumFolderName, data.name, variant)
        if (oldZipPath !== newZipPath) {
          await moveFile(oldZipPath, newZipPath).catch((err) => {
            console.warn(`[album-rename] Failed to rename ${variant} zip (non-fatal):`, err)
          })
        }
      }
    }
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

    if (albumRenamePlan && !isS3Mode()) {
      // StoredFile handles path rebasing for album photos and album ZIPs
      const photoIds = (await tx.albumPhoto.findMany({
        where: { albumId },
        select: { id: true },
      })).map(p => p.id)
      if (photoIds.length > 0) {
        await renameStoredPaths('ALBUM_PHOTO', photoIds, albumRenamePlan.oldAlbumStorageRoot, albumRenamePlan.newAlbumStorageRoot)
      }
      await renameStoredPaths('ALBUM', [albumId], albumRenamePlan.oldAlbumStorageRoot, albumRenamePlan.newAlbumStorageRoot)
    }

    return updatedAlbum
  })
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
          select: {
            id: true,
          },
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

    // Best-effort: delete physical files via StoredFile
    for (const photo of album.photos) {
      try {
        const storedFiles = await prisma.storedFile.findMany({
          where: { entityType: 'ALBUM_PHOTO', entityId: photo.id },
          select: { storagePath: true },
        })
        for (const sf of storedFiles) {
          const sharedCount = await prisma.storedFile.count({
            where: {
              storagePath: sf.storagePath,
              entityType: 'ALBUM_PHOTO',
              entityId: { not: photo.id },
            },
          })
          if (sharedCount === 0) {
            await deleteFile(sf.storagePath)
          }
        }

        // StoredFile already handles all paths — no per-field deletion needed
      } catch {
        // Ignore storage errors; DB is source of truth
      }
    }

    // Delete DB records (in case cascade isn't configured)
    await prisma.albumPhoto.deleteMany({ where: { albumId } })
    await prisma.album.delete({ where: { id: albumId } })

    // Clean up StoredFile rows for all deleted photos and the album
    const photoIds = album.photos.map(p => p.id)
    await prisma.storedFile.deleteMany({
      where: {
        OR: [
          { entityType: 'ALBUM_PHOTO', entityId: { in: photoIds } },
          { entityType: 'ALBUM', entityId: albumId },
        ],
      },
    }).catch(() => {})

    // Compute total bytes from StoredFile for adjustment
    const photoSizeAgg = photoIds.length > 0
      ? await prisma.storedFile.aggregate({
          where: { entityType: 'ALBUM_PHOTO', entityId: { in: photoIds } },
          _sum: { fileSize: true },
        })
      : { _sum: { fileSize: BigInt(0) } }
    const albumZipAgg = await prisma.storedFile.aggregate({
      where: { entityType: 'ALBUM', entityId: albumId, fileRole: { in: ['ZIP_FULL', 'ZIP_SOCIAL'] } },
      _sum: { fileSize: true },
    })
    const photosDelta = BigInt(photoSizeAgg._sum.fileSize ?? 0)
    const zipDelta = BigInt(albumZipAgg._sum.fileSize ?? 0)
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
