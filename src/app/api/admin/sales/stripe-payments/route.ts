import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseInvoiceDocIds(searchParams: URLSearchParams): string[] {
  const rawSingle = searchParams.get('invoiceDocId')
  const rawMany = searchParams.get('invoiceDocIds')

  const parts = [rawSingle, rawMany]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean)

  // Deduplicate + cap to avoid absurd query strings.
  return Array.from(new Set(parts)).slice(0, 200)
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-stripe-payments-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const invoiceDocIds = parseInvoiceDocIds(searchParams)

  const limitParam = searchParams.get('limit')
  const limitCandidate = limitParam ? Number(limitParam) : null
  const limit = Number.isFinite(limitCandidate) ? Math.min(Math.max(1, Math.trunc(limitCandidate as number)), 500) : 200

  const payments = await prisma.salesInvoiceStripePayment.findMany({
    where: invoiceDocIds.length ? { invoiceDocId: { in: invoiceDocIds } } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      shareToken: true,
      invoiceDocId: true,
      invoiceNumber: true,
      currency: true,
      invoiceAmountCents: true,
      feeAmountCents: true,
      totalAmountCents: true,
      stripeCheckoutSessionId: true,
      stripePaymentIntentId: true,
      stripeChargeId: true,
      createdAt: true,
    },
  })

  const res = NextResponse.json({ payments })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
