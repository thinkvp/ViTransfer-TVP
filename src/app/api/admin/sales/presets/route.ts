import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  itemIds: z.array(z.string().min(1)).max(200),
})

function mapPreset(row: any) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    itemIds: Array.isArray(row.items)
      ? row.items
          .slice()
          .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
          .map((it: any) => it.itemId)
      : [],
  }
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-presets-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const rows = await prisma.salesPreset.findMany({
    orderBy: [{ name: 'asc' }],
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  })

  const res = NextResponse.json({ presets: rows.map(mapPreset) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-presets-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { name, itemIds } = parsed.data

  // Verify all referenced items exist
  if (itemIds.length > 0) {
    const found = await prisma.salesItem.count({ where: { id: { in: itemIds } } })
    if (found !== itemIds.length) {
      return NextResponse.json({ error: 'One or more items not found' }, { status: 400 })
    }
  }

  // Upsert: if preset with same name exists, replace its item selections
  const existing = await prisma.salesPreset.findUnique({ where: { name } })

  let preset: any
  if (existing) {
    await prisma.salesPresetItem.deleteMany({ where: { presetId: existing.id } })
    preset = await prisma.salesPreset.update({
      where: { id: existing.id },
      data: {
        updatedAt: new Date(),
        items: {
          create: itemIds.map((itemId, idx) => ({ itemId, sortOrder: idx })),
        },
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    })
  } else {
    preset = await prisma.salesPreset.create({
      data: {
        name,
        items: {
          create: itemIds.map((itemId, idx) => ({ itemId, sortOrder: idx })),
        },
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    })
  }

  return NextResponse.json({ ok: true, preset: mapPreset(preset) }, { status: existing ? 200 : 201 })
}
