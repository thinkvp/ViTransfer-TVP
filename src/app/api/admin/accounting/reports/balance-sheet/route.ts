import { NextRequest, NextResponse } from 'next/server'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { buildBalanceSheetReport } from '@/lib/accounting/reports'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/accounting/reports/balance-sheet?asOf=YYYY-MM-DD
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-report-bs',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const asOf = searchParams.get('asOf') ?? new Date().toISOString().split('T')[0]

  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return NextResponse.json({ error: 'asOf must be in YYYY-MM-DD format' }, { status: 400 })
  }

  const report = await buildBalanceSheetReport(asOf)

  const res = NextResponse.json({ report })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
