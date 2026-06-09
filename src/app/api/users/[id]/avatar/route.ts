import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteFile, getFilePath, uploadFile } from '@/lib/storage'
import { isS3Mode, s3GetPresignedStreamUrl, s3FileExists } from '@/lib/s3-storage'
import { registerStoredFile, deleteStoredFile, getStoredFilePath } from '@/lib/stored-file'
import { createReadStream, statSync } from 'fs'
import sharp from 'sharp'

export const runtime = 'nodejs'

const AVATAR_SIZE = 300 // px — output is always 300×300 JPEG

// ─── GET /api/users/[id]/avatar ─────────────────────────────────────────────
// Serves the user's avatar image. No auth required (rate-limited).
// Returns 404 if no avatar is set or the file is missing.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 600, message: 'Too many requests.' },
    'user-avatar-get',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params

    // Resolve avatar path from StoredFile registry, with fallback to legacy path
    let avatarPath = await getStoredFilePath('USER_AVATAR', id, 'AVATAR')
    if (!avatarPath) {
      // Fallback: try the standard avatar path (for avatars uploaded before StoredFile migration)
      avatarPath = `users/${id}/avatar.jpg`
    }

    if (!avatarPath) {
      return NextResponse.json({ error: 'No avatar' }, { status: 404 })
    }

    // S3 mode: redirect to a presigned stream URL
    if (isS3Mode()) {
      const presignedUrl = await s3GetPresignedStreamUrl(avatarPath, 86400, 'image/jpeg')
      return NextResponse.redirect(presignedUrl, {
        status: 302,
        headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=600' },
      })
    }

    const fullPath = getFilePath(avatarPath)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(fullPath)
    } catch {
      return NextResponse.json({ error: 'Avatar file not found' }, { status: 404 })
    }

    const fileStream = createReadStream(fullPath)
    let closed = false
    const readableStream = new ReadableStream({
      start(controller) {
        fileStream.on('data', (chunk) => {
          if (!closed) controller.enqueue(chunk)
        })
        fileStream.on('end', () => {
          if (!closed) { closed = true; controller.close() }
        })
        fileStream.on('error', (err) => {
          if (!closed) { closed = true; controller.error(err) }
        })
      },
      cancel() {
        closed = true
        fileStream.destroy()
      },
    })

    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': stat.size.toString(),
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    console.error('Error serving user avatar:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}

// ─── POST /api/users/[id]/avatar ─────────────────────────────────────────────
// Upload or replace the user's avatar. Accepts multipart/form-data with an
// 'image' field containing a PNG or JPEG file. The server resizes to 300×300.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'users')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests.' },
    'user-avatar-upload',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: userId } = await params

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const formData = await request.formData()
    const imageFile = formData.get('image')
    if (!imageFile || typeof imageFile === 'string') {
      return NextResponse.json({ error: 'No image file provided' }, { status: 400 })
    }

    const mimeType = imageFile.type
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(mimeType)) {
      return NextResponse.json(
        { error: 'Only JPEG and PNG files are accepted' },
        { status: 400 },
      )
    }

    const buffer = Buffer.from(await imageFile.arrayBuffer())
    if (buffer.length > 20 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'File too large (max 20 MB before processing)' },
        { status: 400 },
      )
    }

    // Resize + convert to 300×300 JPEG (cover crop, centered)
    const processed = await sharp(buffer)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 85, progressive: true })
      .toBuffer()

    // Store at a stable, predictable path (replaces any previous avatar)
    const storagePath = `users/${userId}/avatar.jpg`

    await uploadFile(storagePath, processed, processed.length, 'image/jpeg')

    // Delete old avatar file if it was at a different path
    const oldAvatarPath = await getStoredFilePath('USER_AVATAR', userId, 'AVATAR')
    if (oldAvatarPath && oldAvatarPath !== storagePath) {
      await deleteFile(oldAvatarPath).catch(() => {})
    }

    // Register the new avatar in StoredFile
    await registerStoredFile({
      entityType: 'USER_AVATAR', entityId: userId, fileRole: 'AVATAR',
      storagePath, fileSize: processed.length, status: 'READY',
    })

    return NextResponse.json({ ok: true, avatarPath: storagePath })
  } catch (error) {
    console.error('Error uploading user avatar:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}

// ─── DELETE /api/users/[id]/avatar ───────────────────────────────────────────
// Removes the user's avatar.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'users')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  try {
    const { id: userId } = await params

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Delete the avatar file and StoredFile record
    const avatarPath = await getStoredFilePath('USER_AVATAR', userId, 'AVATAR')
    if (avatarPath) {
      await deleteFile(avatarPath).catch(() => {})
      await deleteStoredFile('USER_AVATAR', userId, 'AVATAR')
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error deleting user avatar:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
