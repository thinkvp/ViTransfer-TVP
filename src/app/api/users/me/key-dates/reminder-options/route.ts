import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/users/me/key-dates/reminder-options - users for reminder targeting (personal key dates)
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'user-key-dates-reminder-options'
  )
  if (rateLimitResult) return rateLimitResult

  // For personal key dates, keep targeting limited to the current user.
  const user = await prisma.user.findUnique({
    where: { id: authResult.id },
    select: { id: true, name: true, email: true },
  })

  const users = user?.email
    ? [{ id: user.id, name: user.name || user.email, email: user.email }]
    : []

  return NextResponse.json({ users })
}
