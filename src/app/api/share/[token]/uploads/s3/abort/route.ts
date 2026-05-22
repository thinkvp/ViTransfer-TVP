import { type NextRequest, NextResponse } from 'next/server'
import { isS3Mode, s3AbortMultipartUpload } from '@/lib/s3-storage'
import { rateLimit } from '@/lib/rate-limit'
import { buildProjectUploadsRoot } from '@/lib/project-storage-paths'
import { resolveProjectStoragePath, resolveShareUploadAccess } from '@/lib/share-uploads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!isS3Mode()) {
    return NextResponse.json({ error: 'S3 storage is not enabled' }, { status: 404 })
  }

  const { token } = await params

  const limited = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests' },
    `share-uploads-s3-abort:${token}`,
  )
  if (limited) return limited

  const access = await resolveShareUploadAccess(request, token)
  if (access instanceof Response) return access

  if (!access.canUpload) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const uploadId = String(body?.uploadId || '').trim()
  const key = String(body?.key || '').trim()

  if (!uploadId) {
    return NextResponse.json({ error: 'uploadId is required' }, { status: 400 })
  }
  if (!key) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 })
  }

  const projectStoragePath = resolveProjectStoragePath(access.project)
  const uploadsRoot = buildProjectUploadsRoot(projectStoragePath)
  if (key !== uploadsRoot && !key.startsWith(`${uploadsRoot}/`)) {
    return NextResponse.json({ error: 'Invalid upload key' }, { status: 400 })
  }

  try {
    await s3AbortMultipartUpload(key, uploadId)
    return NextResponse.json({ ok: true })
  } catch (error: any) {
    if (error?.name === 'NoSuchUpload' || error?.$metadata?.httpStatusCode === 404) {
      return NextResponse.json({ ok: true })
    }
    console.error('[SHARE UPLOADS S3 ABORT] Failed to abort multipart upload:', error)
    return NextResponse.json({ error: 'Failed to abort upload' }, { status: 500 })
  }
}
