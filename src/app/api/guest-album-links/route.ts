import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { GUEST_ALBUM_LINK_TTL_MS, noStore, randomGuestAlbumLinkToken } from '@/lib/guest-album-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Admin auth OR a share JWT for the album's own project (from /share/* pages) — the same
 * rule as /api/guest-video-links.
 */
async function requireGuestAlbumLinkContext(
  request: NextRequest,
  rawAlbumId: unknown
): Promise<
  | {
      ok: true
      album: { id: string; name: string; projectId: string }
      project: { id: string; title: string }
    }
  | { ok: false; response: NextResponse }
> {
  const { isAdmin, shareContext } = await getAuthContext(request)
  if (!isAdmin && !shareContext) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const albumId = typeof rawAlbumId === 'string' ? rawAlbumId.trim() : ''
  if (!albumId) {
    return { ok: false, response: NextResponse.json({ error: 'albumId is required' }, { status: 400 }) }
  }

  const album = await prisma.album.findUnique({
    where: { id: albumId },
    select: {
      id: true,
      name: true,
      projectId: true,
      project: { select: { id: true, title: true, status: true, enablePhotos: true } },
    },
  })

  if (!album) {
    return { ok: false, response: NextResponse.json({ error: 'Album not found' }, { status: 404 }) }
  }

  if (shareContext && !isAdmin && shareContext.projectId !== album.projectId) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  if (album.project.status === 'CLOSED') {
    return { ok: false, response: NextResponse.json({ error: 'Project is closed' }, { status: 403 }) }
  }

  if (album.project.enablePhotos === false) {
    return { ok: false, response: NextResponse.json({ error: 'Album not found' }, { status: 404 }) }
  }

  return {
    ok: true,
    album: { id: album.id, name: album.name, projectId: album.projectId },
    project: { id: album.project.id, title: album.project.title },
  }
}

function linkResponse(row: { token: string; expiresAt: Date }, album: { id: string; name: string }) {
  return noStore(NextResponse.json({
    token: row.token,
    urlPath: `/ga/${row.token}`,
    expiresAt: row.expiresAt,
    isExpired: row.expiresAt.getTime() <= Date.now(),
    album: { id: album.id, name: album.name },
  }))
}

/**
 * GET /api/guest-album-links?albumId=...
 *
 * Returns the stored guest link (if any) for this album.
 */
export async function GET(request: NextRequest) {
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please try again later.' },
    'guest-album-link-get'
  )
  if (rateLimitResult) return rateLimitResult

  const albumId = new URL(request.url).searchParams.get('albumId') || ''
  const ctx = await requireGuestAlbumLinkContext(request, albumId)
  if (!ctx.ok) return ctx.response

  const row = await prisma.guestAlbumShareLink.findUnique({
    where: { projectId_albumId: { projectId: ctx.project.id, albumId: ctx.album.id } },
    select: { token: true, expiresAt: true },
  })

  if (!row) {
    return noStore(NextResponse.json({ error: 'Not found' }, { status: 404 }))
  }

  return linkResponse(row, ctx.album)
}

/**
 * POST /api/guest-album-links  { action: 'generate' | 'refreshExpiry', albumId }
 *
 * generate: create or rotate the token and reset the 14-day expiry.
 * refreshExpiry: keep the existing token, reset the expiry (falls back to generate).
 */
export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please try again later.' },
    'guest-album-link-gen'
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)
  const action = body?.action === 'refreshExpiry' ? 'refreshExpiry' : 'generate'

  const ctx = await requireGuestAlbumLinkContext(request, body?.albumId)
  if (!ctx.ok) return ctx.response

  const where = { projectId_albumId: { projectId: ctx.project.id, albumId: ctx.album.id } }
  const expiresAt = new Date(Date.now() + GUEST_ALBUM_LINK_TTL_MS)

  if (action === 'refreshExpiry') {
    const existing = await prisma.guestAlbumShareLink.findUnique({ where, select: { id: true } })
    if (existing) {
      const row = await prisma.guestAlbumShareLink.update({
        where,
        data: { expiresAt },
        select: { token: true, expiresAt: true },
      })
      return linkResponse(row, ctx.album)
    }
  }

  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomGuestAlbumLinkToken()
    try {
      const row = await prisma.guestAlbumShareLink.upsert({
        where,
        create: { token, projectId: ctx.project.id, albumId: ctx.album.id, expiresAt },
        update: { token, expiresAt },
        select: { token: true, expiresAt: true },
      })
      return linkResponse(row, ctx.album)
    } catch (e) {
      // Token collisions are vanishingly unlikely, but retry if one happens.
      lastError = e
    }
  }

  console.error('[GUEST-ALBUM-LINK] Failed to generate token', lastError)
  return NextResponse.json({ error: 'Unable to generate link' }, { status: 500 })
}
