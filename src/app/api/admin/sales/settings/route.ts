import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { salesSettingsFromDb } from '@/lib/sales/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const settingsSchema = z.object({
  businessName: z.string().trim().max(200),
  address: z.string().trim().max(2000),
  abn: z.string().trim().max(100),
  phone: z.string().trim().max(100),
  email: z.string().trim().max(320),
  website: z.string().trim().max(500),
  businessRegistrationLabel: z.string().trim().min(1).max(100),
  currencySymbol: z.string().trim().min(1).max(10),
  currencyCode: z.string().trim().min(1).max(10),
  quoteLabel: z.string().trim().max(100).default('QUOTE'),
  invoiceLabel: z.string().trim().max(100).default('INVOICE'),
  taxLabel: z.string().trim().max(100).default(''),
  taxEnabled: z.boolean().default(true),
  taxRatePercent: z.number().finite().min(0).max(100),
  defaultQuoteValidDays: z.number().int().min(0).max(3650),
  defaultInvoiceDueDays: z.number().int().min(0).max(3650),
  defaultTerms: z.string().trim().max(10000),
  paymentDetails: z.string().trim().max(10000),
})

function defaultSalesSettings() {
  return {
    id: 'default',
    businessName: '',
    address: '',
    abn: '',
    phone: '',
    email: '',
    website: '',
    businessRegistrationLabel: 'ABN',
    currencySymbol: '$',
    currencyCode: 'AUD',
    quoteLabel: 'QUOTE',
    invoiceLabel: 'INVOICE',
    taxLabel: '',
    taxEnabled: true,
    taxRatePercent: 10,
    defaultQuoteValidDays: 14,
    defaultInvoiceDueDays: 7,
    defaultTerms: 'Payment due within 7 days unless otherwise agreed.',
    paymentDetails: '',
  }
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-settings-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const row = await prisma.salesSettings.upsert({
    where: { id: 'default' },
    create: defaultSalesSettings(),
    update: {},
  })

  const res = NextResponse.json(salesSettingsFromDb(row as any))
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-settings-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = settingsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data

  const row = await prisma.salesSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...input },
    update: { ...input },
  })

  return NextResponse.json({ ok: true, settings: salesSettingsFromDb(row as any) })
}
