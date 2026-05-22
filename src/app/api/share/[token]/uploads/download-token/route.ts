import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { resolveShareUploadAccess } from '@/lib/share-uploads'
import { generateShareUploadAccessToken } from '@/lib/share-upload-access'
import { ensureShareUploadPreview, isShareUploadVideoFileType } from '@/lib/share-upload-video-thumbnail'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    `share-uploads-download-token:${token}`,
  )
  if (rateLimitResult) return rateLimitResult

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canRead) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const fileId = String(body?.fileId || '').trim()
  if (!fileId) {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 })
  }

  const file = await prisma.shareUploadFile.findFirst({
    where: {
      id: fileId,
      projectId: access.project.id,
    },
    select: {
      id: true,
      projectId: true,
      storagePath: true,
      fileName: true,
      fileType: true,
      fileSize: true,
      mediaDurationSeconds: true,
    },
  })

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const downloadToken = await generateShareUploadAccessToken({
    projectId: file.projectId,
    fileId: file.id,
    storagePath: file.storagePath,
    fileName: file.fileName,
    fileType: file.fileType,
    fileSize: Number(file.fileSize),
    request,
    sessionId: access.shareTokenSessionId || null,
  })

  const baseUrl = `/api/share/uploads/content/${downloadToken}`
  const isImageUpload = String(file.fileType || '').toLowerCase().startsWith('image/')
  const isVideoUpload = isShareUploadVideoFileType(file.fileType)
  let previewUrl = isImageUpload ? `${baseUrl}?variant=thumbnail` : baseUrl

  if (isImageUpload || isVideoUpload) {
    const thumbnail = await ensureShareUploadPreview({
      storagePath: file.storagePath,
      fileName: file.fileName,
      fileType: file.fileType,
      durationSeconds: file.mediaDurationSeconds,
    })

    if (thumbnail) {
      const thumbnailToken = await generateShareUploadAccessToken({
        projectId: file.projectId,
        fileId: file.id,
        storagePath: thumbnail.storagePath,
        fileName: thumbnail.fileName,
        fileType: thumbnail.fileType,
        fileSize: thumbnail.fileSize,
        request,
        sessionId: access.shareTokenSessionId || null,
      })
      previewUrl = `/api/share/uploads/content/${thumbnailToken}`
    }
  }

  const downloadUrl = `${baseUrl}?download=true`

  return NextResponse.json({
    // Keep `url` for backward compatibility with existing callers expecting direct download URL.
    url: downloadUrl,
    downloadUrl,
    previewUrl,
  })
}
