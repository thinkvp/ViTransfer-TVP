import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { getAlbumZipReadiness } from '@/lib/album-share'
import { noStore, resolveGuestAlbumLink } from '@/lib/guest-album-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/guest-album-links/[token]/zip-status — lightweight ZIP readiness poll (fixed URL,
// so repeated polls cost one CrowdSec bucket entry).
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    `guest-album-zip-status:${token}`
  )
  if (rateLimitResult) return rateLimitResult

  const resolved = await resolveGuestAlbumLink(token)
  if (!resolved.ok) return resolved.response

  const zip = await getAlbumZipReadiness(resolved.link.album, { includeQueueState: true })
  return noStore(NextResponse.json({ zip }))
}
