import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RAW_BYTES = 2_500_000 // ~2.5MB (plenty for typical sales docs)
const MAX_LIST_ITEMS = 10_000

const storeDataSchema = z.object({
  // These are arbitrary JSON arrays (SalesQuote/SalesInvoice/SalesPayment shapes),
  // but we validate basic structure + bounds and rely on JSON.parse() for JSON-ness.
  quotes: z.array(z.any()).max(MAX_LIST_ITEMS),
  invoices: z.array(z.any()).max(MAX_LIST_ITEMS),
  payments: z.array(z.any()).max(MAX_LIST_ITEMS),
  settings: z.any(),
  seq: z.object({
    quote: z.number().int().nonnegative(),
    invoice: z.number().int().nonnegative(),
  }),
})

function defaultStoreData() {
  return {
    quotes: [],
    invoices: [],
    payments: [],
    settings: {},
    seq: { quote: 0, invoice: 0 },
  }
}

async function getOrCreateDefaultStore() {
  return prisma.salesNativeStore.upsert({
    where: { id: 'default' },
    create: { id: 'default', data: defaultStoreData() },
    update: {},
    select: { data: true, updatedAt: true },
  })
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-native-store-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const row = await getOrCreateDefaultStore()

  const res = NextResponse.json({ data: row.data, updatedAt: row.updatedAt.toISOString() })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-native-store-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const raw = await request.text()
  if (raw.length > MAX_RAW_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const dataResult = storeDataSchema.safeParse((parsed as any)?.data)
  if (!dataResult.success) {
    return NextResponse.json({ error: 'Invalid store payload', details: dataResult.error.flatten() }, { status: 400 })
  }

  const jsonData = dataResult.data as unknown as Prisma.InputJsonValue

  const updated = await prisma.salesNativeStore.upsert({
    where: { id: 'default' },
    create: { id: 'default', data: jsonData },
    update: { data: jsonData },
    select: { updatedAt: true },
  })

  const res = NextResponse.json({ ok: true, updatedAt: updated.updatedAt.toISOString() })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
