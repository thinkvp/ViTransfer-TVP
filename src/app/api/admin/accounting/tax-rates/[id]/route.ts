import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAX_CODES = ['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED'] as const

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  code: z.enum(TAX_CODES).optional(),
  rate: z.number().min(0).max(1).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
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

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 60, message: 'Too many requests' }, 'accounting-tax-rate-put', authResult.id)
  if (rl) return rl

  const { id } = await params
  const existing = await prisma.taxRate.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Tax rate not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const d = parsed.data

  // If setting as default, clear other defaults for same code
  const targetCode = d.code ?? existing.code
  if (d.isDefault === true) {
    await prisma.taxRate.updateMany({ where: { code: targetCode, isDefault: true, id: { not: id } }, data: { isDefault: false } })
  }

  const rate = await prisma.taxRate.update({ where: { id }, data: { ...d } })
  const res = NextResponse.json({ taxRate: taxRateFromDb(rate) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, message: 'Too many requests' }, 'accounting-tax-rate-delete', authResult.id)
  if (rl) return rl

  const { id } = await params
  const existing = await prisma.taxRate.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Tax rate not found' }, { status: 404 })

  // Check if any transactions reference this rate via code
  // We don't store taxRateId on transactions (they store the code string), so safe to delete
  await prisma.taxRate.delete({ where: { id } })

  return NextResponse.json({ ok: true })
}
