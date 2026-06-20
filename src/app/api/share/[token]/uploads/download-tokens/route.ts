import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { resolveShareUploadAccess } from '@/lib/share-uploads'
import { generateShareUploadAccessToken } from '@/lib/share-upload-access'
import { isShareUploadImageFileType, isShareUploadVideoFileType } from '@/lib/share-upload-video-thumbnail'
import { enqueueShareUploadPreview } from '@/lib/queue'
import { getStoredFileRecords } from '@/lib/stored-file'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Batch sibling of ./download-token. Mints download/playback/preview tokens for many
// upload files in a single request so the FILES browser doesn't fire one POST per
// visible tile. Each file's result mirrors the single-file route exactly.
const MAX_BATCH = 100

type FileTokenResult = {
  url: string
  downloadUrl: string
  playbackUrl: string
  previewUrl?: string
  previewStatus: string | null
}

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
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    `share-uploads-download-tokens:${token}`,
    access.shareTokenSessionId || undefined,
  )
  if (rateLimitResult) return rateLimitResult

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawIds = Array.isArray(body?.fileIds) ? body.fileIds : []
  const fileIds = Array.from(
    new Set(
      rawIds
        .map((id: unknown) => String(id || '').trim())
        .filter((id: string) => id.length > 0),
    ),
  ) as string[]

  if (fileIds.length === 0) {
    return NextResponse.json({ error: 'fileIds is required' }, { status: 400 })
  }
  if (fileIds.length > MAX_BATCH) {
    return NextResponse.json({ error: `Too many fileIds (max ${MAX_BATCH})` }, { status: 400 })
  }

  const files = await prisma.shareUploadFile.findMany({
    where: {
      id: { in: fileIds },
      projectId: access.project.id,
    },
    select: {
      id: true,
      projectId: true,
      fileName: true,
      fileType: true,
      mediaDurationSeconds: true,
      previewStatus: true,
    },
  })

  // Resolve original + preview storage paths for the whole batch up front.
  const [originalRecords, previewRecords] = await Promise.all([
    getStoredFileRecords('SHARE_UPLOAD_FILE', fileIds, {
      fileRoles: ['ORIGINAL'],
      select: { entityId: true, storagePath: true, fileSize: true },
    }),
    getStoredFileRecords('SHARE_UPLOAD_FILE', fileIds, {
      fileRoles: ['PREVIEW_IMAGE', 'PREVIEW_MP4'],
      select: { entityId: true, storagePath: true, fileSize: true },
    }),
  ])

  const originalByFileId = new Map<string, { storagePath: string; fileSize: bigint | number | null }>()
  for (const r of originalRecords) originalByFileId.set(r.entityId, { storagePath: r.storagePath, fileSize: r.fileSize })
  const previewByFileId = new Map<string, { storagePath: string; fileSize: bigint | number | null }>()
  for (const r of previewRecords) {
    // First preview record per file wins (matches single-route `records[0]`).
    if (!previewByFileId.has(r.entityId)) previewByFileId.set(r.entityId, { storagePath: r.storagePath, fileSize: r.fileSize })
  }

  const results: Record<string, FileTokenResult> = {}

  await Promise.all(
    files.map(async (file) => {
      const original = originalByFileId.get(file.id) ?? null
      const originalStoragePath = original?.storagePath ?? ''

      const downloadToken = await generateShareUploadAccessToken({
        projectId: file.projectId,
        fileId: file.id,
        storagePath: originalStoragePath,
        fileName: file.fileName,
        fileType: file.fileType,
        fileSize: original?.fileSize ? Number(original.fileSize) : 0,
        request,
        sessionId: access.shareTokenSessionId || null,
      })

      const baseUrl = `/api/share/uploads/content/${downloadToken}`
      const isPreviewable = isShareUploadImageFileType(file.fileType) || isShareUploadVideoFileType(file.fileType)
      const isVideoFile = isShareUploadVideoFileType(file.fileType)
      let previewUrl: string | null = null

      if (isPreviewable) {
        const previewStored = previewByFileId.get(file.id) ?? null
        if (file.previewStatus === 'READY' && previewStored) {
          const thumbnailToken = await generateShareUploadAccessToken({
            projectId: file.projectId,
            fileId: file.id,
            storagePath: previewStored.storagePath,
            fileName: `${file.fileName}.jpg`,
            fileType: 'image/jpeg',
            fileSize: Math.max(0, Number(previewStored.fileSize || 0)),
            request,
            sessionId: access.shareTokenSessionId || null,
          })
          previewUrl = `/api/share/uploads/content/${thumbnailToken}`
        } else if (!isVideoFile) {
          // Image with no ready preview: serve original as fallback preview.
          previewUrl = baseUrl
        }

        if (!file.previewStatus || file.previewStatus === 'FAILED') {
          void enqueueShareUploadPreview({
            type: 'shareUploadFile',
            recordId: file.id,
            storagePath: originalStoragePath,
            fileType: file.fileType,
            fileName: file.fileName,
            durationSeconds: file.mediaDurationSeconds,
          }).catch(() => {})
        }
      }

      const downloadUrl = `${baseUrl}?download=true`
      results[file.id] = {
        url: downloadUrl,
        downloadUrl,
        playbackUrl: baseUrl,
        ...(previewUrl !== null ? { previewUrl } : {}),
        previewStatus: file.previewStatus ?? null,
      }
    }),
  )

  return NextResponse.json({ results })
}
