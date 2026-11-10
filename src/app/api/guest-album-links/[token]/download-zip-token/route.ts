import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { getRedis } from '@/lib/redis'
import { enqueueMissingAlbumZips, getAlbumZipReadiness } from '@/lib/album-share'
import { guestAlbumLinkSessionId, noStore, resolveGuestAlbumLink } from '@/lib/guest-album-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  variant: z.enum(['full', 'social']).optional(),
})

/**
 * POST /api/guest-album-links/[token]/download-zip-token
 *
 * Mints a short-lived one-off download URL for the album's pre-built ZIP (served by
 * /api/content/photo-zip/[token], which records the ALBUM_DOWNLOAD analytics event).
 * 202 + retryAfterMs while the ZIP is still being generated.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many download requests. Please slow down.' },
    `guest-album-zip-token:${token}`
  )
  if (rateLimitResult) return rateLimitResult

  const resolved = await resolveGuestAlbumLink(token)
  if (!resolved.ok) return resolved.response
  const { album } = resolved.link

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
  }
  const variant = parsed.data.variant || 'full'

  if (variant === 'social' && !album.socialCopiesEnabled) {
    return NextResponse.json({ error: 'Social downloads are not enabled for this album' }, { status: 400 })
  }

  const readyCount = await prisma.albumPhoto.count({ where: { albumId: album.id, status: 'READY' } })
  if (readyCount === 0) {
    return NextResponse.json({ error: 'No photos available' }, { status: 404 })
  }

  const readiness = await getAlbumZipReadiness(album)
  const zipReady = variant === 'full' ? readiness.fullReady : readiness.socialReady
  if (!zipReady) {
    await enqueueMissingAlbumZips(album, readiness, [variant])
    return noStore(NextResponse.json({ status: 'generating', retryAfterMs: 5000 }, { status: 202 }))
  }

  const downloadToken = crypto.randomBytes(32).toString('base64url')
  await getRedis().setex(
    `photo_zip_download:${downloadToken}`,
    15 * 60,
    JSON.stringify({
      projectId: resolved.link.project.id,
      albumId: album.id,
      variant,
      sessionId: guestAlbumLinkSessionId(resolved.link.token),
      createdAt: Date.now(),
    })
  )

  return noStore(NextResponse.json({ url: `/api/content/photo-zip/${downloadToken}` }))
}
