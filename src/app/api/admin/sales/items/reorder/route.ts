import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const reorderItemsSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(100)).min(1),
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

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-items-reorder-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = reorderItemsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const itemIds = Array.from(new Set(parsed.data.itemIds))
  const existing = await prisma.salesItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true },
  })

  if (existing.length !== itemIds.length) {
    return NextResponse.json({ error: 'One or more items could not be found.' }, { status: 404 })
  }

  await prisma.$transaction(
    itemIds.map((id, index) =>
      prisma.salesItem.update({
        where: { id },
        data: { sortOrder: index },
      })
    )
  )

  const rows = await prisma.salesItem.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { label: { select: { name: true, color: true } } },
  })

  const res = NextResponse.json({ ok: true, items: rows.map(mapItem) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}