import { type NextRequest, NextResponse } from 'next/server'
import { consumeShareUploadAccessToken } from '@/lib/share-upload-access'
import { downloadFile, sanitizeFilenameForHeader } from '@/lib/storage'
import { createWebReadableStream } from '@/lib/stream-utils'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const access = await consumeShareUploadAccessToken(token, request)

  if (!access) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  let stream: NodeJS.ReadableStream
  try {
    stream = await downloadFile(access.storagePath)
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const searchParams = new URL(request.url).searchParams
  const isDownload = searchParams.get('download') === 'true'
  const variant = String(searchParams.get('variant') || '').trim().toLowerCase()
  const safeName = sanitizeFilenameForHeader(access.fileName)

  const isImageUpload = String(access.fileType || '').toLowerCase().startsWith('image/')
  const wantsImagePreview = !isDownload && isImageUpload && (variant === 'thumbnail' || variant === 'preview')

  if (wantsImagePreview) {
    const maxEdge = variant === 'thumbnail' ? 640 : 1600
    const quality = variant === 'thumbnail' ? 76 : 84

    const transformer = sharp()
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })

    ;(stream as any).pipe(transformer)

    return new Response(createWebReadableStream(transformer as any), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(access.fileName)}`,
      },
    })
  }

  const size = Math.max(0, Number(access.fileSize || 0))
  const headers: Record<string, string> = {
    'Content-Type': access.fileType || 'application/octet-stream',
    'Cache-Control': 'private, max-age=60',
    'Content-Disposition': isDownload
      ? `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(access.fileName)}`
      : `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(access.fileName)}`,
  }

  if (size > 0) {
    headers['Content-Length'] = String(size)
  }

  return new Response(createWebReadableStream(stream as any), {
    headers,
  })
}
