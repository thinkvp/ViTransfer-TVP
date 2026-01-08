import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
export const runtime = 'nodejs'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  permissions: z.unknown().optional(),
})

function requireUsersMenuAccess(user: any): Response | null {
  const permissions = normalizeRolePermissions(user?.permissions)
  if (!canSeeMenu(permissions, 'users')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request)
  if (auth instanceof Response) return auth

  const forbidden = requireUsersMenuAccess(auth)
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: 'Too many requests. Please slow down.'
  }, 'roles-update')
  if (rateLimitResult) return rateLimitResult

  const { id } = await params

  const roleDelegate = (prisma as any).role
  const existing = await roleDelegate.findUnique({
    where: { id },
    select: { id: true, isSystemAdmin: true },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  }

  if (existing.isSystemAdmin || id === 'role_admin') {
    return NextResponse.json({ error: 'Admin role cannot be edited' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const updateData: any = {}
  if (parsed.data.name !== undefined) {
    const name = parsed.data.name.trim()
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (name.toLowerCase() === 'admin') {
      return NextResponse.json({ error: 'Admin role already exists' }, { status: 400 })
    }
    updateData.name = name
  }
  if (parsed.data.permissions !== undefined) {
    updateData.permissions = parsed.data.permissions ?? {}
  }

  try {
    const role = await roleDelegate.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, isSystemAdmin: true, permissions: true },
    })

    const response = NextResponse.json({ role })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'Role name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request)
  if (auth instanceof Response) return auth

  const forbidden = requireUsersMenuAccess(auth)
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many requests. Please slow down.'
  }, 'roles-delete')
  if (rateLimitResult) return rateLimitResult

  const { id } = await params

  const roleDelegate = (prisma as any).role
  const role = await roleDelegate.findUnique({
    where: { id },
    select: { id: true, isSystemAdmin: true, _count: { select: { users: true } } },
  })

  if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  if (role.isSystemAdmin || id === 'role_admin') {
    return NextResponse.json({ error: 'Admin role cannot be deleted' }, { status: 400 })
  }

  if (role._count.users > 0) {
    return NextResponse.json({ error: 'Role cannot be deleted while users are assigned to it' }, { status: 400 })
  }

  try {
    await roleDelegate.delete({ where: { id } })
  } catch {
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }

  const response = NextResponse.json({ success: true })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}
