import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateItemSchema = z.object({
  description: z.string().trim().min(1).max(500).optional(),
  details: z.string().max(10000).optional(),
  quantity: z.number().finite().min(0).optional(),
  unitPriceCents: z.number().int().finite().optional(),
  taxRatePercent: z.number().finite().min(0).max(100).optional(),
  taxRateName: z.string().max(200).optional().nullable(),
  labelId: z.string().trim().min(1).max(100).optional().nullable(),
})

function mapItem(row: any) {
  return {
    id: row.id,
    description: row.description,
    details: row.details ?? '',
    quantity: Number(row.quantity),
    unitPriceCents: Number(row.unitPriceCents),
    taxRatePercent: Number(row.taxRatePercent),
    taxRateName: row.taxRateName ?? undefined,
    labelId: row.labelId ?? null,
    labelName: row.label?.name ?? null,
    labelColor: row.label?.color ?? null,
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
    'admin-sales-items-patch',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params

  const parsed = updateItemSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const existing = await prisma.salesItem.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  }

  const data = parsed.data
  const updated = await prisma.salesItem.update({
    where: { id },
    data: {
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.details !== undefined ? { details: data.details } : {}),
      ...(data.quantity !== undefined ? { quantity: data.quantity } : {}),
      ...(data.unitPriceCents !== undefined ? { unitPriceCents: data.unitPriceCents } : {}),
      ...(data.taxRatePercent !== undefined ? { taxRatePercent: data.taxRatePercent } : {}),
      ...(data.taxRateName !== undefined ? { taxRateName: data.taxRateName ?? null } : {}),
      ...(data.labelId !== undefined ? { labelId: data.labelId ?? null } : {}),
    },
    include: { label: { select: { name: true, color: true } } },
  })

  const res = NextResponse.json({ ok: true, item: mapItem(updated) })
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
    'admin-sales-items-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params

  const existing = await prisma.salesItem.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  }

  // Cascade removes SalesPresetItem join rows automatically
  await prisma.salesItem.delete({ where: { id } })

  return NextResponse.json({ ok: true })
}
