import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  details: z.string().max(10000).default(''),
  quantity: z.number().finite().min(0),
  unitPriceCents: z.number().int().finite(),
  taxRatePercent: z.number().finite().min(0).max(100),
  taxRateName: z.string().max(200).optional().nullable(),
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
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-items-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const rows = await prisma.salesItem.findMany({
    orderBy: [{ createdAt: 'asc' }],
  })

  const res = NextResponse.json({ items: rows.map(mapItem) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-items-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = createItemSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const item = await prisma.salesItem.create({
    data: {
      description: parsed.data.description,
      details: parsed.data.details ?? '',
      quantity: parsed.data.quantity,
      unitPriceCents: parsed.data.unitPriceCents,
      taxRatePercent: parsed.data.taxRatePercent,
      taxRateName: parsed.data.taxRateName ?? null,
    },
  })

  return NextResponse.json({ ok: true, item: mapItem(item) }, { status: 201 })
}
