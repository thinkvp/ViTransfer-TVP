import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'
import { z } from 'zod'
export const runtime = 'nodejs'

export const dynamic = 'force-dynamic'

const roleSchema = z.object({
  name: z.string().min(1).max(50),
  permissions: z.unknown().optional(),
})

function requireUsersMenuAccess(user: any): Response | null {
  const permissions = normalizeRolePermissions(user?.permissions)
  if (!canSeeMenu(permissions, 'users')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  const auth = await requireApiAuth(request)
  if (auth instanceof Response) return auth

  const forbidden = requireUsersMenuAccess(auth)
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: 'Too many requests. Please slow down.'
  }, 'roles-list')
  if (rateLimitResult) return rateLimitResult

  const roleDelegate = (prisma as any).role
  const roles = await roleDelegate.findMany({
    select: {
      id: true,
      name: true,
      isSystemAdmin: true,
      permissions: true,
      _count: { select: { users: true } },
    },
    orderBy: [{ isSystemAdmin: 'desc' }, { name: 'asc' }],
  })

  const response = NextResponse.json({ roles: roles.map((r: any) => ({ ...r, userCount: r._count.users, _count: undefined })) })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth(request)
  if (auth instanceof Response) return auth

  const forbidden = requireUsersMenuAccess(auth)
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many requests. Please slow down.'
  }, 'roles-create')
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)
  const parsed = roleSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const name = parsed.data.name.trim()
  if (name.toLowerCase() === 'admin') {
    return NextResponse.json({ error: 'Admin role already exists' }, { status: 400 })
  }

  const roleDelegate = (prisma as any).role
  const role = await roleDelegate.create({
    data: {
      name,
      isSystemAdmin: false,
      permissions: parsed.data.permissions ?? {},
    },
    select: {
      id: true,
      name: true,
      isSystemAdmin: true,
      permissions: true,
    },
  })

  const response = NextResponse.json({ role }, { status: 201 })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}
