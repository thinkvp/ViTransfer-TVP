import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getAlbumZipDropboxPath, getAlbumZipStoragePath, albumZipExists } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot, getStoragePathBasename } from '@/lib/project-storage-paths'
import { isDropboxStorageConfigured, deleteDropboxFile } from '@/lib/storage-provider-dropbox'
import { getFilePath } from '@/lib/storage'
import fs from 'fs'
import { z } from 'zod'
import { clearResolvedDropboxStorageIssueEntities } from '@/lib/dropbox-storage-inconsistency-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  enabled: z.boolean(),
})

// POST /api/albums/[albumId]/zip-dropbox
// Enable or disable Dropbox upload for album ZIPs.
// When enabling, queues uploads for any variants whose ZIPs already exist.
// When disabling, deletes any Dropbox-hosted ZIPs and clears tracking fields.
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
    'album-zip-dropbox'
  )
  if (rateLimitResult) return rateLimitResult

  if (!isDropboxStorageConfigured()) {
    return NextResponse.json({ error: 'Dropbox is not configured' }, { status: 400 })
  }

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
      fullZipDropboxPath: true,
      socialZipDropboxPath: true,
    },
  })

  if (!album) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

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

  if (!enabled) {
    // Disable: clear tracking fields and delete Dropbox files
    const pathsToClear = [album.fullZipDropboxPath, album.socialZipDropboxPath].filter(Boolean) as string[]
    await Promise.allSettled(pathsToClear.map((p) => deleteDropboxFile('', p).catch(() => {})))

    await prisma.album.update({
      where: { id: album.id },
      data: {
        dropboxEnabled: false,
        fullZipDropboxStatus: null,
        fullZipDropboxProgress: 0,
        fullZipDropboxError: null,
        fullZipDropboxPath: null,
        socialZipDropboxStatus: null,
        socialZipDropboxProgress: 0,
        socialZipDropboxError: null,
        socialZipDropboxPath: null,
      },
    })

    await clearResolvedDropboxStorageIssueEntities([
      {
        entityType: 'album-zip',
        entityId: `${album.id}:full`,
        projectId: album.projectId,
      },
      {
        entityType: 'album-zip',
        entityId: `${album.id}:social`,
        projectId: album.projectId,
      },
    ])

    return NextResponse.json({ ok: true, enabled: false })
  }

  // Enable: set flag and queue uploads for variants with existing ZIPs
  await prisma.album.update({
    where: { id: album.id },
    data: { dropboxEnabled: true },
  })

  const projectStoragePath = project.storagePath
    || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)
  const albumFolderName = album.storageFolderName || album.name

  const variants = (['full', 'social'] as const).filter((variant) => {
    const storagePath = getAlbumZipStoragePath({
      projectStoragePath,
      albumFolderName,
      albumName: album.name,
      variant,
    })
    return albumZipExists(storagePath)
  })

  if (variants.length > 0) {
    try {
      const { getAlbumZipDropboxUploadQueue } = await import('@/lib/queue')
      const q = getAlbumZipDropboxUploadQueue()

      for (const variant of variants) {
        const storagePath = getAlbumZipStoragePath({
          projectStoragePath,
          albumFolderName,
          albumName: album.name,
          variant,
        })
        const dropboxPath = getAlbumZipDropboxPath({
          clientName: project.client?.name || project.companyName || 'Client',
          projectFolderName: getStoragePathBasename(project.storagePath) || project.title,
          albumFolderName,
          albumName: album.name,
          variant,
        })
        const jobId = `album-zip-dropbox-${variant}-${album.id}`

        let fileSizeBytes = 0
        try {
          fileSizeBytes = fs.statSync(getFilePath(storagePath)).size
        } catch {
          fileSizeBytes = 0
        }

        await q.remove(jobId).catch(() => {})
        await q.add(
          'upload-album-zip-to-dropbox',
          { albumId: album.id, variant, localPath: storagePath, dropboxPath, fileSizeBytes },
          { jobId }
        )

        const statusField = variant === 'full' ? 'fullZipDropboxStatus' : 'socialZipDropboxStatus'
        const pathField = variant === 'full' ? 'fullZipDropboxPath' : 'socialZipDropboxPath'
        await prisma.album.update({
          where: { id: album.id },
          data: {
            [statusField]: 'PENDING',
            [pathField]: dropboxPath,
          },
        })
      }
    } catch (err) {
      console.error('[zip-dropbox] Failed to queue Dropbox uploads:', err)
    }
  }

  return NextResponse.json({ ok: true, enabled: true, queued: variants.length })
}
