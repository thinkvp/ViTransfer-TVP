import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { allocateUniqueStorageName } from '@/lib/project-storage-paths'
import { getStoredFileRecords } from '@/lib/stored-file'
import { asNumberBigInt } from '@/lib/utils'
import { generateAlbumPhotoAccessToken } from '@/lib/photo-access'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createAlbumSchema = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().max(500).nullable().optional(),
  socialCopiesEnabled: z.boolean().optional(),
})

// GET /api/projects/[id]/albums - list albums (admin)
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'manageProjectAlbums')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-albums-list'
  )
  if (rateLimitResult) return rateLimitResult

  const { id: projectId } = await params

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      status: true,
      storagePath: true,
      assignedUsers: { select: { userId: true } },
    },
  })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  if (auth.appRoleIsSystemAdmin !== true) {
    const assigned = project.assignedUsers?.some((u) => u.userId === auth.id)
    if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (!isVisibleProjectStatusForUser(auth, project.status)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const albums = await prisma.album.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { photos: true } },
      // First ready photo is used to render the album cover thumbnail in the admin card list.
      photos: {
        where: { status: 'READY' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { id: true },
      },
    },
  })

  // Legacy fullZipFileSize/socialZipFileSize columns dropped — read from StoredFile
  const albumIds = albums.map(a => a.id)
  const albumZipFiles = albumIds.length > 0 ? await getStoredFileRecords('ALBUM', albumIds, {
    fileRoles: ['ZIP_FULL', 'ZIP_SOCIAL'],
    select: { entityId: true, fileRole: true, fileSize: true },
  }) : []
  const zipSizeByAlbum = new Map<string, Map<string, bigint | null>>()
  for (const f of albumZipFiles) {
    if (!zipSizeByAlbum.has(f.entityId)) zipSizeByAlbum.set(f.entityId, new Map())
    zipSizeByAlbum.get(f.entityId)!.set(f.fileRole, f.fileSize)
  }

  // Admin sessions can mint photo-access tokens directly (the photo content route
  // accepts any `admin:`-prefixed session). Use a per-user stable session id so the
  // token generator's Redis cache is reused across list refreshes.
  const adminSessionId = `admin:${auth.id}`

  const albumsSafe = await Promise.all(
    albums.map(async (a) => {
      const sizes = zipSizeByAlbum.get(a.id)
      const firstPhotoId = (a as any)?.photos?.[0]?.id as string | undefined

      let coverThumbnailUrl: string | null = null
      if (firstPhotoId) {
        try {
          const tokenValue = await generateAlbumPhotoAccessToken({
            photoId: firstPhotoId,
            albumId: a.id,
            projectId,
            request,
            sessionId: adminSessionId,
          })
          coverThumbnailUrl = `/api/content/photo/${tokenValue}?variant=thumbnail`
        } catch {
          // Cover thumbnail is best-effort; fall back to the icon in the UI.
        }
      }

      const { photos: _firstPhotos, ...rest } = a as any
      return {
        ...rest,
        coverThumbnailUrl,
        fullZipFileSize: asNumberBigInt(sizes?.get('ZIP_FULL')),
        socialZipFileSize: asNumberBigInt(sizes?.get('ZIP_SOCIAL')),
      }
    })
  )

  return NextResponse.json({ albums: albumsSafe })
}

// POST /api/projects/[id]/albums - create album (admin)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'manageProjectAlbums')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'project-albums-create'
  )
  if (rateLimitResult) return rateLimitResult

  const { id: projectId } = await params

  const body = await request.json().catch(() => null)
  const parsed = createAlbumSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      status: true,
      assignedUsers: { select: { userId: true } },
    },
  })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  if (auth.appRoleIsSystemAdmin !== true) {
    const assigned = project.assignedUsers?.some((u) => u.userId === auth.id)
    if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (!isVisibleProjectStatusForUser(auth, project.status)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const name = parsed.data.name.trim()
  const notesRaw = typeof parsed.data.notes === 'string' ? parsed.data.notes.trim() : null
  const notes = notesRaw ? notesRaw : null
  const siblingAlbums = await prisma.album.findMany({
    where: { projectId },
    select: { storageFolderName: true, name: true },
  })
  const storageFolderName = allocateUniqueStorageName(
    name,
    siblingAlbums.map((row) => row.storageFolderName || row.name).filter(Boolean) as string[],
  )

  const album = await prisma.album.create({
    data: {
      projectId,
      name,
      storageFolderName,
      notes,
      socialCopiesEnabled: parsed.data.socialCopiesEnabled !== false,
    },
  })

  return NextResponse.json(
    {
      album: {
        ...album,
        fullZipFileSize: 0,
        socialZipFileSize: 0,
      },
    },
    { status: 201 }
  )
}
