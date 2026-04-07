import { NextRequest, NextResponse } from 'next/server'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { buildProfitLossReport } from '@/lib/accounting/reports'
import { getAccountingReportingBasis } from '@/lib/accounting/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/accounting/reports/profit-loss?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=CASH|ACCRUAL
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-report-pl',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const requestedBasis = searchParams.get('basis')

  if (!from || !to) {
    return NextResponse.json({ error: 'from and to query params are required (YYYY-MM-DD)' }, { status: 400 })
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'Dates must be in YYYY-MM-DD format' }, { status: 400 })
  }

  if (from > to) {
    return NextResponse.json({ error: 'from must be before or equal to to' }, { status: 400 })
  }

  const basis = requestedBasis === 'ACCRUAL' || requestedBasis === 'CASH'
    ? requestedBasis
    : await getAccountingReportingBasis()

  const report = await buildProfitLossReport(from, to, basis)

  const res = NextResponse.json({ report })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
