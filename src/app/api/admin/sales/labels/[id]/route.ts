import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateLabelSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
  accountId: z.string().trim().min(1).max(100).optional().nullable(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(99999).optional(),
})

function mapLabel(row: any) {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? null,
    accountId: row.accountId ?? null,
    accountName: row.account?.name ?? null,
    accountCode: row.account?.code ?? null,
    isActive: Boolean(row.isActive),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-labels-patch',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params

  const parsed = updateLabelSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const existing = await prisma.salesLabel.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Label not found' }, { status: 404 })
  }

  const { name, color, accountId, isActive, sortOrder } = parsed.data

  // Check name uniqueness if name is being changed
  if (name && name !== existing.name) {
    const clash = await prisma.salesLabel.findUnique({ where: { name } })
    if (clash) {
      return NextResponse.json({ error: 'A label with this name already exists.' }, { status: 409 })
    }
  }

  const updated = await prisma.salesLabel.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(color !== undefined ? { color: color ?? null } : {}),
      ...(accountId !== undefined ? { accountId: accountId ?? null } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    },
    include: { account: { select: { name: true, code: true } } },
  })

  const res = NextResponse.json({ ok: true, label: mapLabel(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-labels-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params

  const existing = await prisma.salesLabel.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Label not found' }, { status: 404 })
  }

  await prisma.salesLabel.delete({ where: { id } })

  return NextResponse.json({ ok: true })
}
