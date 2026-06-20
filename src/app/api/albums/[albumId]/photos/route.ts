import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest, requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { validateAlbumPhotoFile } from '@/lib/photo-validation'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { adjustProjectTotalBytes } from '@/lib/project-total-bytes'
import { buildAlbumPhotoStoragePath, buildAlbumPhotoThumbnailStoragePath, buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { z } from 'zod'
import { getStoredFileRecords, registerStoredFile } from '@/lib/stored-file'
import { generateAlbumPhotoAccessToken } from '@/lib/photo-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createPhotoSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.union([z.number(), z.string()]).transform((v) => Number(v)).refine((v) => Number.isFinite(v) && Number.isInteger(v) && v > 0, {
    message: 'fileSize must be a positive integer',
  }),
  mimeType: z.string().max(255).optional(),
})

// GET /api/albums/[albumId]/photos - list photos (admin)
export async function GET(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'manageProjectAlbums')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'album-photos-list'
  )
  if (rateLimitResult) return rateLimitResult

  const { albumId } = await params

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: { id: true, projectId: true, name: true, storageFolderName: true, project: { select: { storagePath: true } } },
  })
  if (!album) return NextResponse.json({ error: 'Album not found' }, { status: 404 })

  // Reflect immediate work in progress (uploading).
  await prisma.album.update({
    where: { id: album.id },
    data: { status: 'UPLOADING' },
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

  const photos = await prisma.albumPhoto.findMany({
    where: { albumId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      albumId: true,
      fileName: true,
      fileType: true,
      status: true,
      thumbnailStatus: true,
      error: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  const photoIds = photos.map(p => p.id)
  const storedSizes = photoIds.length > 0 ? await getStoredFileRecords('ALBUM_PHOTO', photoIds, { fileRoles: ['ORIGINAL'], select: { entityId: true, fileSize: true } }) : []
  const sizeByPhotoId = new Map(storedSizes.map(s => [s.entityId, s.fileSize ? String(s.fileSize) : '0']))

  // Mint per-photo thumbnail URLs so the admin album manager can render a thumbnail grid.
  // Admin sessions are accepted by the photo content route; a per-user stable session id
  // lets the token generator reuse its Redis cache across refreshes. The content route
  // gracefully falls back (social/original) when a dedicated thumbnail isn't ready.
  const adminSessionId = `admin:${auth.id}`
  const thumbnailUrlByPhotoId = new Map<string, string>()
  await Promise.all(
    photos
      .filter((p) => p.status === 'READY')
      .map(async (p) => {
        try {
          const tokenValue = await generateAlbumPhotoAccessToken({
            photoId: p.id,
            albumId,
            projectId: album.projectId,
            request,
            sessionId: adminSessionId,
          })
          thumbnailUrlByPhotoId.set(p.id, `/api/content/photo/${tokenValue}?variant=thumbnail`)
        } catch {
          // Best-effort; the UI falls back to a placeholder tile.
        }
      })
  )

  return NextResponse.json({
    photos: photos.map((p) => ({
      ...p,
      fileSize: sizeByPhotoId.get(p.id) ?? '0',
      thumbnailUrl: thumbnailUrlByPhotoId.get(p.id) ?? null,
    })),
  })
}

// POST /api/albums/[albumId]/photos - create photo record for TUS upload (admin)
export async function POST(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(auth, 'manageProjectAlbums')
  if (forbiddenAction) return forbiddenAction

  const { albumId } = await params

  const rateLimitResult = await rateLimit(
    request,
    // Bulk photo uploads can create hundreds of records quickly.
    // Scope by admin+album to avoid shared IP/user-agent lockouts and allow batch uploads.
    { windowMs: 60 * 1000, maxRequests: 300, message: 'Too many upload requests. Please slow down.' },
    'album-photos-create',
    `${auth.id}:${albumId}`
  )
  if (rateLimitResult) return rateLimitResult

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      projectId: true,
      name: true,
      storageFolderName: true,
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

  const currentUser = await getCurrentUserFromRequest(request)
  if (!currentUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const parsed = createPhotoSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const { fileName, fileSize, mimeType } = parsed.data

  const validation = validateAlbumPhotoFile(fileName, mimeType || 'application/octet-stream')
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error || 'Invalid file' }, { status: 400 })
  }

  const timestamp = Date.now()
  const safeName = validation.sanitizedFilename || fileName.replace(/[^a-zA-Z0-9 ._&-]/g, '_').substring(0, 255)

  // Allocate a collision-free filename within the album
  const existingPhotos = await prisma.albumPhoto.findMany({
    where: { albumId: album.id },
    select: { fileName: true },
  })
  const usedNames = new Set(existingPhotos.map((p) => p.fileName.toLowerCase()))
  let uniqueName = safeName
  if (usedNames.has(uniqueName.toLowerCase())) {
    const dotIdx = safeName.lastIndexOf('.')
    const base = dotIdx > 0 ? safeName.slice(0, dotIdx) : safeName
    const ext = dotIdx > 0 ? safeName.slice(dotIdx) : ''
    let counter = 2
    while (usedNames.has(`${base} (${counter})${ext}`.toLowerCase())) {
      counter++
    }
    uniqueName = `${base} (${counter})${ext}`
  }

  const projectStoragePath = album.project.storagePath
    || buildProjectStorageRoot(album.project.client?.name || album.project.companyName || 'Client', album.project.title)
  const storagePath = buildAlbumPhotoStoragePath(projectStoragePath, album.storageFolderName || album.name, uniqueName)
  const thumbnailStoragePath = buildAlbumPhotoThumbnailStoragePath(projectStoragePath, storagePath)

  const photo = await prisma.albumPhoto.create({
    data: {
      albumId: album.id,
      fileName: uniqueName,
      fileType: 'application/octet-stream',
      status: 'UPLOADING',
      uploadedBy: currentUser.id,
      uploadedByName: currentUser.name || currentUser.email,
    },
  })

  // Register in StoredFile
  await registerStoredFile({
    entityType: 'ALBUM_PHOTO',
    entityId: photo.id,
    fileRole: 'ORIGINAL',
    storagePath,
    fileName: uniqueName,
    fileSize: BigInt(fileSize),
  })

  await adjustProjectTotalBytes(album.projectId, BigInt(fileSize))

  return NextResponse.json({ photoId: photo.id }, { status: 201 })
}
