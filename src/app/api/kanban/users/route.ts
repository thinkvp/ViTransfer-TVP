import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/kanban/users
 *
 * Returns a minimal list of active admin users for task assignment.
 * Safe for all authenticated internal users — deliberately excludes
 * email, phone, password, and other sensitive fields.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests.' },
    'kanban-users-list'
  )
  if (rateLimitResult) return rateLimitResult

  const users = await prisma.user.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      displayColor: true,
      avatarPath: true,
    },
    orderBy: [{ name: 'asc' }],
  })

  return NextResponse.json({ users }, { headers: { 'Cache-Control': 'no-store' } })
}
