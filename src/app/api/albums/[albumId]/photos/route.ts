import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin, getCurrentUserFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { validateAlbumPhotoFile } from '@/lib/photo-validation'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { z } from 'zod'

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
  const auth = await requireApiAdmin(request)
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

  const album = await prisma.album.findUnique({ where: { id: albumId }, select: { id: true, projectId: true } })
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

  const photos = await prisma.albumPhoto.findMany({ where: { albumId }, orderBy: { createdAt: 'desc' } })
  const serialized = photos.map((p) => ({ ...p, fileSize: p.fileSize.toString() }))
  return NextResponse.json({ photos: serialized })
}

// POST /api/albums/[albumId]/photos - create photo record for TUS upload (admin)
export async function POST(request: NextRequest, { params }: { params: Promise<{ albumId: string }> }) {
  const auth = await requireApiAdmin(request)
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

  const album = await prisma.album.findUnique({ where: { id: albumId }, select: { id: true, projectId: true } })
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
  const safeName = validation.sanitizedFilename || fileName.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 255)
  const storagePath = `projects/${album.projectId}/albums/${album.id}/photos/photo-${timestamp}-${safeName}`

  const photo = await prisma.albumPhoto.create({
    data: {
      albumId: album.id,
      fileName: safeName,
      fileSize: BigInt(fileSize),
      fileType: 'application/octet-stream',
      storagePath,
      status: 'UPLOADING',
      uploadedBy: currentUser.id,
      uploadedByName: currentUser.name || currentUser.email,
    },
  })

  return NextResponse.json({ photoId: photo.id }, { status: 201 })
}
