import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getAlbumZipStoragePath, getAlbumZipJobId, albumZipExists } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot, getStoragePathBasename } from '@/lib/project-storage-paths'
import { deleteFile, getFilePath } from '@/lib/storage'
import { isDropboxStorageConfigured, deleteDropboxFile } from '@/lib/storage-provider-dropbox'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { syncAlbumZipSizes } from '@/lib/album-zip-size-sync'
import fs from 'fs'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  enabled: z.boolean(),
})

// POST /api/albums/[albumId]/social-copies
// Enable or disable social-media-sized downloads for an album.
// Social derivatives are always generated (used as previews); this toggle controls
// whether the social-sized ZIP download is available.
// When enabling, queues a social ZIP job (and backfills derivatives for pre-migration albums).
// When disabling, deletes the social ZIP and clears ZIP-related tracking.
export async function POST(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'manageProjectAlbums')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'album-social-copies'
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }
  const { enabled } = parsed.data

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
      socialZipDropboxPath: true,
    },
  })

  if (!album) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  // No-op if already in the desired state
  if (album.socialCopiesEnabled === enabled) {
    return NextResponse.json({ ok: true, enabled })
  }

  const project = await prisma.project.findUnique({
    where: { id: album.projectId },
    select: { title: true, status: true, storagePath: true, companyName: true, client: { select: { name: true } }, assignedUsers: { select: { userId: true } } },
  })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  if (auth.appRoleIsSystemAdmin !== true) {
    const assigned = project.assignedUsers?.some((u) => u.userId === auth.id)
    if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (!isVisibleProjectStatusForUser(auth, project.status)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const projectStoragePath = project.storagePath
    || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)
  const albumFolderName = album.storageFolderName || album.name

  if (!enabled) {
    // --- Disable social media downloads ---
    // Social derivatives are kept (used as previews); only the social ZIP is removed.

    // 1. Delete the social ZIP
    let freedBytes = BigInt(0)
    const socialZipPath = getAlbumZipStoragePath({
      projectStoragePath,
      albumFolderName,
      albumName: album.name,
      variant: 'social',
    })
    try {
      const fullPath = getFilePath(socialZipPath)
      const stat = fs.statSync(fullPath)
      freedBytes += BigInt(stat.size)
      await deleteFile(socialZipPath)
    } catch {
      // ZIP may not exist
    }

    // 2. If Dropbox enabled, delete social ZIP from Dropbox
    if (album.dropboxEnabled && album.socialZipDropboxPath) {
      await deleteDropboxFile('', album.socialZipDropboxPath).catch(() => {})
    }

    // 3. Update album: disable social downloads, clear social ZIP tracking
    await prisma.album.update({
      where: { id: album.id },
      data: {
        socialCopiesEnabled: false,
        socialZipFileSize: BigInt(0),
        socialZipDropboxStatus: null,
        socialZipDropboxProgress: 0,
        socialZipDropboxError: null,
        socialZipDropboxPath: null,
      },
    })

    // 4. Adjust project total bytes
    if (freedBytes > BigInt(0)) {
      await adjustProjectTotalBytes(album.projectId, -freedBytes)
    }

    // 5. Sync sizes
    await syncAlbumZipSizes({ albumId: album.id, projectId: album.projectId }).catch(() => {})

    return NextResponse.json({ ok: true, enabled: false })
  }

  // --- Enable social downloads ---
  await prisma.album.update({
    where: { id: album.id },
    data: { socialCopiesEnabled: true },
  })

  // Backfill: queue social derivatives for any READY photos missing them
  // (shouldn't happen for new albums since derivatives are always generated,
  //  but covers pre-migration albums)
  const photosToProcess = await prisma.albumPhoto.findMany({
    where: {
      albumId,
      status: 'READY',
      OR: [
        { socialStoragePath: null },
        { socialStatus: 'ERROR' },
      ],
    },
    select: { id: true, storagePath: true, socialStoragePath: true },
  })

  let queued = 0
  if (photosToProcess.length > 0) {
    try {
      const { getAlbumPhotoSocialQueue } = await import('@/lib/queue')
      const q = getAlbumPhotoSocialQueue()

      for (const photo of photosToProcess) {
        const socialPath = photo.socialStoragePath || `${photo.storagePath}-social.jpg`

        await prisma.albumPhoto.update({
          where: { id: photo.id },
          data: {
            socialStoragePath: socialPath,
            socialStatus: 'PENDING',
            socialError: null,
          },
        })

        await q.add(
          'process-album-photo-social',
          { photoId: photo.id },
          { jobId: `album-photo-social-${photo.id}` }
        )
        queued++
      }
    } catch (err) {
      console.error('[social-copies] Failed to queue social derivative jobs:', err)
    }
  }

  // Queue a social ZIP job (will wait for derivatives if any are still pending)
  try {
    const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
    const q = getAlbumPhotoZipQueue()
    const jobId = getAlbumZipJobId({ albumId: album.id, variant: 'social' })

    await q.remove(jobId).catch(() => {})
    await q.add(
      'generate-album-photo-zip',
      { albumId: album.id, variant: 'social' },
      { jobId, delay: 5000 }
    )
  } catch (err) {
    console.error('[social-copies] Failed to queue social ZIP job:', err)
  }

  return NextResponse.json({ ok: true, enabled: true, queued })
}
