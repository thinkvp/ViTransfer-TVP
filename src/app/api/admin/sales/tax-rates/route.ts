import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const taxRateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  rate: z.number().finite().min(0).max(100),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
})

const bulkSchema = z.object({
  rates: z.array(z.object({
    id: z.string().max(100).optional(),
    name: z.string().trim().min(1).max(100),
    rate: z.number().finite().min(0).max(100),
    isDefault: z.boolean(),
    sortOrder: z.number().int().min(0).max(10000),
  })).min(1).max(50),
})

function mapTaxRate(row: any) {
  return {
    id: row.id,
    name: row.name,
    rate: Number(row.rate),
    isDefault: Boolean(row.isDefault),
    sortOrder: Number(row.sortOrder ?? 0),
  }
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-tax-rates-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const rows = await prisma.salesTaxRate.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })

  const res = NextResponse.json({ rates: rows.map(mapTaxRate) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-tax-rates-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)

  // Bulk replace mode: { rates: [...] }
  const bulkParsed = bulkSchema.safeParse(body)
  if (bulkParsed.success) {
    const input = bulkParsed.data

    // Ensure exactly one default
    const defaultCount = input.rates.filter((r) => r.isDefault).length
    if (defaultCount !== 1) {
      return NextResponse.json({ error: 'Exactly one tax rate must be marked as default' }, { status: 400 })
    }

    await prisma.$transaction(async (tx) => {
      // Delete all existing rates
      await tx.salesTaxRate.deleteMany({})

      // Insert new rates
      for (const rate of input.rates) {
        await tx.salesTaxRate.create({
          data: {
            id: rate.id || undefined,
            name: rate.name,
            rate: rate.rate,
            isDefault: rate.isDefault,
            sortOrder: rate.sortOrder,
          },
        })
      }

      // Update the SalesSettings.taxRatePercent to match the new default
      const defaultRate = input.rates.find((r) => r.isDefault)
      if (defaultRate) {
        await tx.salesSettings.upsert({
          where: { id: 'default' },
          create: { id: 'default', taxRatePercent: defaultRate.rate },
          update: { taxRatePercent: defaultRate.rate },
        })
      }
    })

    const rows = await prisma.salesTaxRate.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })

    return NextResponse.json({ ok: true, rates: rows.map(mapTaxRate) })
  }

  // Single-add mode
  const parsed = taxRateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data

  const maxOrder = await prisma.salesTaxRate.aggregate({ _max: { sortOrder: true } })
  const nextOrder = (maxOrder._max.sortOrder ?? 0) + 1

  if (input.isDefault) {
    // Unset other defaults
    await prisma.salesTaxRate.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
  }

  const row = await prisma.salesTaxRate.create({
    data: {
      name: input.name,
      rate: input.rate,
      isDefault: input.isDefault ?? false,
      sortOrder: input.sortOrder ?? nextOrder,
    },
  })

  return NextResponse.json({ ok: true, rate: mapTaxRate(row) })
}

export async function DELETE(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-tax-rates-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 })
  }

  const existing = await prisma.salesTaxRate.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Tax rate not found' }, { status: 404 })
  }

  const count = await prisma.salesTaxRate.count()
  if (count <= 1) {
    return NextResponse.json({ error: 'Cannot delete the last tax rate' }, { status: 400 })
  }

  await prisma.salesTaxRate.delete({ where: { id } })

  // If we deleted the default, make the first remaining one the default
  if (existing.isDefault) {
    const first = await prisma.salesTaxRate.findFirst({ orderBy: { sortOrder: 'asc' } })
    if (first) {
      await prisma.salesTaxRate.update({ where: { id: first.id }, data: { isDefault: true } })
    }
  }

  return NextResponse.json({ ok: true })
}
