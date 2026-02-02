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
    'admin-sales-stripe-payments-summary-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const invoiceDocIds = parseInvoiceDocIds(searchParams)

  if (invoiceDocIds.length === 0) {
    const res = NextResponse.json({ summaries: [] })
    res.headers.set('Cache-Control', 'no-store')
    return res
  }

  const grouped = await prisma.salesInvoiceStripePayment.groupBy({
    by: ['invoiceDocId'],
    where: { invoiceDocId: { in: invoiceDocIds } },
    _sum: { invoiceAmountCents: true },
    _max: { createdAt: true },
  })

  const summaries = grouped.map((g) => {
    const paidCentsRaw = Number(g?._sum?.invoiceAmountCents ?? 0)
    const paidCents = Number.isFinite(paidCentsRaw) ? Math.max(0, Math.trunc(paidCentsRaw)) : 0

    const latest: unknown = (g as any)?._max?.createdAt
    const latestYmd = latest instanceof Date
      ? latest.toISOString().slice(0, 10)
      : (typeof latest === 'string' && /^\d{4}-\d{2}-\d{2}/.test(latest) ? latest.slice(0, 10) : null)

    return {
      invoiceDocId: g.invoiceDocId,
      paidCents,
      latestYmd,
    }
  })

  const res = NextResponse.json({ summaries })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
