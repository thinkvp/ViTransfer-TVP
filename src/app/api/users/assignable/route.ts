import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/users/assignable - List non-system-admin users for project assignment
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many requests. Please slow down.',
    },
    'assignable-users-list'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const url = new URL(request.url)
    const query = (url.searchParams.get('query') || '').trim()
    const takeRaw = Number(url.searchParams.get('take') || '25')
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 50) : 25

    const users = await prisma.user.findMany({
      where: {
        appRole: { isSystemAdmin: false },
        ...(query
          ? {
              OR: [
                { name: { contains: query, mode: 'insensitive' } },
                { email: { contains: query, mode: 'insensitive' } },
                { username: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        appRole: {
          select: {
            id: true,
            name: true,
            isSystemAdmin: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }],
      take,
    })

    const response = NextResponse.json({ users })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
