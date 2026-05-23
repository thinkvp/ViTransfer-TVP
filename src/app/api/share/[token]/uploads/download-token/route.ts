import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { resolveShareUploadAccess } from '@/lib/share-uploads'
import { generateShareUploadAccessToken } from '@/lib/share-upload-access'
import { isShareUploadImageFileType, isShareUploadVideoFileType } from '@/lib/share-upload-video-thumbnail'
import { enqueueShareUploadPreview } from '@/lib/queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canRead) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 600, message: 'Too many requests. Please slow down.' },
    `share-uploads-download-token:${token}`,
    access.shareTokenSessionId || undefined,
  )
  if (rateLimitResult) return rateLimitResult

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
      previewStatus: true,
      previewPath: true,
      previewFileSize: true,
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
  const isPreviewable = isShareUploadImageFileType(file.fileType) || isShareUploadVideoFileType(file.fileType)
  const isVideoFile = isShareUploadVideoFileType(file.fileType)
  // null means "no preview available" — UI shows icon fallback
  let previewUrl: string | null = null

  if (isPreviewable) {
    if (file.previewStatus === 'READY' && file.previewPath) {
      // Preview is ready — serve thumbnail directly
      const thumbnailToken = await generateShareUploadAccessToken({
        projectId: file.projectId,
        fileId: file.id,
        storagePath: file.previewPath,
        fileName: `${file.fileName}.jpg`,
        fileType: 'image/jpeg',
        fileSize: Math.max(0, Number(file.previewFileSize || 0)),
        request,
        sessionId: access.shareTokenSessionId || null,
      })
      previewUrl = `/api/share/uploads/content/${thumbnailToken}`
    } else if (!isVideoFile) {
      // For non-video (image) files with no ready preview: serve original as fallback preview
      previewUrl = baseUrl
    }
    // For videos with PENDING/PROCESSING/FAILED/null: previewUrl stays null → icon + badge in UI

    if (!file.previewStatus || file.previewStatus === 'FAILED') {
      // Missing or failed — trigger backfill enqueue (non-blocking best effort)
      void enqueueShareUploadPreview({
        type: 'shareUploadFile',
        recordId: file.id,
        storagePath: file.storagePath,
        fileType: file.fileType,
        fileName: file.fileName,
        durationSeconds: file.mediaDurationSeconds,
      }).catch(() => {})
    }
  }

  const downloadUrl = `${baseUrl}?download=true`

  return NextResponse.json({
    // Keep `url` for backward compatibility with existing callers expecting direct download URL.
    url: downloadUrl,
    downloadUrl,
    ...(previewUrl !== null ? { previewUrl } : {}),
    previewStatus: file.previewStatus ?? null,
  })
}
