import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { getAppUrl } from '@/lib/url'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function generateCalendarFeedToken(): string {
  // URL-safe, high-entropy token.
  return crypto.randomBytes(32).toString('base64url')
}

function buildFeedUrl(appUrl: string, token: string): string {
  const url = new URL('/api/calendar/key-dates', appUrl)
  url.searchParams.set('token', token)
  return url.toString()
}

// GET /api/users/me/calendar-feed - returns a subscribe URL (creates token if missing)
export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'user-calendar-feed-get'
  )
  if (rateLimitResult) return rateLimitResult

  const appUrl = await getAppUrl(request)

  const existing = await prisma.user.findUnique({
    where: { id: authResult.id },
    select: { calendarFeedToken: true },
  })

  let token = existing?.calendarFeedToken || null
  if (!token) {
    token = generateCalendarFeedToken()
    await prisma.user.update({
      where: { id: authResult.id },
      data: { calendarFeedToken: token },
      select: { id: true },
    })
  }

  return NextResponse.json({ url: buildFeedUrl(appUrl, token) })
}

// POST /api/users/me/calendar-feed - rotate the token (returns new subscribe URL)
export async function POST(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'user-calendar-feed-rotate'
  )
  if (rateLimitResult) return rateLimitResult

  const appUrl = await getAppUrl(request)
  const token = generateCalendarFeedToken()

  await prisma.user.update({
    where: { id: authResult.id },
    data: { calendarFeedToken: token },
    select: { id: true },
  })

  return NextResponse.json({ url: buildFeedUrl(appUrl, token) })
}
