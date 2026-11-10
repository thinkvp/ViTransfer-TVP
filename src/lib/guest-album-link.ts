import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { ALBUM_ZIP_SOURCE_SELECT } from '@/lib/album-share'

/** Guest album links last 14 days from generation / last refresh (same as guest video links). */
export const GUEST_ALBUM_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** Analytics/notification dedupe window per (link, viewer IP). */
export const GUEST_ALBUM_VIEW_DEDUPE_SECONDS = 6 * 60 * 60

export function guestAlbumLinkSessionId(token: string): string {
  return `guest-album-link:${token}`
}

export function isGuestAlbumLinkSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('guest-album-link:')
}

export function randomGuestAlbumLinkToken(): string {
  // 24 bytes => 32 chars base64url, non-guessable.
  return crypto.randomBytes(24).toString('base64url')
}

export function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}

/** Tokens are base64url; reject anything else before touching the DB. */
function isPlausibleToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(token)
}

/**
 * Resolve a public guest album token. Invalid (404) when the token is unknown, the project is
 * CLOSED or has photos disabled, or the album is gone; 410 when expired. (Album status is not
 * checked: it flips to PROCESSING whenever photos are added, and the share page ignores it too.)
 * Unknown and disabled look the same so a token's existence never leaks.
 */
export async function resolveGuestAlbumLink(token: string) {
  if (!isPlausibleToken(token)) {
    return { ok: false as const, response: noStore(NextResponse.json({ error: 'Not found' }, { status: 404 })) }
  }

  const link = await prisma.guestAlbumShareLink.findUnique({
    where: { token },
    select: {
      token: true,
      expiresAt: true,
      project: { select: { id: true, title: true, status: true, enablePhotos: true } },
      album: {
        select: {
          ...ALBUM_ZIP_SOURCE_SELECT,
          projectId: true,
          notes: true,
          createdAt: true,
        },
      },
    },
  })

  if (!link) {
    return { ok: false as const, response: noStore(NextResponse.json({ error: 'Not found' }, { status: 404 })) }
  }
  if (link.expiresAt.getTime() <= Date.now()) {
    return { ok: false as const, response: noStore(NextResponse.json({ error: 'Expired' }, { status: 410 })) }
  }
  if (
    link.project.status === 'CLOSED'
    || link.project.enablePhotos === false
    || !link.album
    || link.album.projectId !== link.project.id
  ) {
    return { ok: false as const, response: noStore(NextResponse.json({ error: 'Not found' }, { status: 404 })) }
  }

  return { ok: true as const, link }
}
