import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAX_CODES = ['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED'] as const

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.enum(TAX_CODES),
  rate: z.number().min(0).max(1),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  notes: z.string().trim().max(2000).optional().nullable(),
})

function taxRateFromDb(row: any) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    rate: row.rate,
    isDefault: row.isDefault,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    notes: row.notes ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 120, message: 'Too many requests' }, 'accounting-tax-rates-get', authResult.id)
  if (rl) return rl

  const { searchParams } = new URL(request.url)
  const includeInactive = searchParams.get('includeInactive') === 'true'

  const rates = await prisma.taxRate.findMany({
    where: includeInactive ? undefined : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })

  const res = NextResponse.json({ taxRates: rates.map(taxRateFromDb) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, message: 'Too many requests' }, 'accounting-tax-rates-post', authResult.id)
  if (rl) return rl

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const d = parsed.data

  // If this is being set as default, clear other defaults for same code
  if (d.isDefault) {
    await prisma.taxRate.updateMany({ where: { code: d.code, isDefault: true }, data: { isDefault: false } })
  }

  const rate = await prisma.taxRate.create({ data: { name: d.name, code: d.code, rate: d.rate, isDefault: d.isDefault, isActive: d.isActive, sortOrder: d.sortOrder, notes: d.notes ?? null } })

  const res = NextResponse.json({ taxRate: taxRateFromDb(rate) }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
