import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { getRedis } from '@/lib/redis'
import crypto from 'crypto'
import { z } from 'zod'
import { albumZipExists, getAlbumZipJobId, getAlbumZipStoragePath } from '@/lib/album-photo-zip'

export const runtime = 'nodejs'

const downloadZipTokenSchema = z.object({
  variant: z.enum(['full', 'social']).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; albumId: string }> }
) {
  const { token, albumId } = await params

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many download requests. Please slow down.',
    },
    `album-photo-zip-token:${albumId}`
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const project = await prisma.project.findUnique({
      where: { slug: token },
      select: { id: true, sharePassword: true, authMode: true, guestMode: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)
    if (!accessCheck.authorized) {
      return accessCheck.errorResponse || NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const album = await prisma.album.findUnique({
      where: { id: albumId },
      select: { id: true, projectId: true, name: true },
    })

    if (!album || album.projectId !== project.id) {
      return NextResponse.json({ error: 'Album not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const parsed = downloadZipTokenSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }

    const variant = parsed.data.variant || 'full'

    // Always download all photos as a pre-generated ZIP.
    const readyCount = await prisma.albumPhoto.count({
      where: { albumId, status: 'READY' },
    })
    if (readyCount === 0) {
      return NextResponse.json({ error: 'No photos available' }, { status: 404 })
    }

    const zipStoragePath = getAlbumZipStoragePath({ projectId: album.projectId, albumId: album.id, variant })
    const zipReady = albumZipExists(zipStoragePath)

    if (!zipReady) {
      // Best-effort: enqueue ZIP generation and tell the client to retry.
      try {
        const { getAlbumPhotoZipQueue } = await import('@/lib/queue')
        const q = getAlbumPhotoZipQueue()
        const jobId = getAlbumZipJobId({ albumId: album.id, variant })
        await q.remove(jobId).catch(() => {})
        await q.add('generate-album-zip', { albumId: album.id, variant }, { jobId, delay: 10_000 }).catch(() => {})
      } catch {
        // ignore
      }

      const response = NextResponse.json({ status: 'generating', retryAfterMs: 5000 }, { status: 202 })
      response.headers.set('Cache-Control', 'no-store')
      response.headers.set('Pragma', 'no-cache')
      return response
    }

    const downloadToken = crypto.randomBytes(32).toString('base64url')

    const sessionId =
      accessCheck.shareTokenSessionId || (accessCheck.isAdmin ? `admin:${Date.now()}` : `anon:${Date.now()}`)

    const redis = getRedis()
    await redis.setex(
      `photo_zip_download:${downloadToken}`,
      15 * 60,
      JSON.stringify({
        projectId: project.id,
        albumId,
        variant,
        sessionId,
        createdAt: Date.now(),
      })
    )

    const response = NextResponse.json({ url: `/api/content/photo-zip/${downloadToken}` })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Photo ZIP token generation error:', error)
    return NextResponse.json({ error: 'Failed to generate download link' }, { status: 500 })
  }
}
