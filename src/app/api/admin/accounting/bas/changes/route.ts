import { NextRequest, NextResponse } from 'next/server'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getLodgedPeriodDrift } from '@/lib/accounting/bas-adjustments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/accounting/bas/changes
// Per lodged period: how many changes since lodgement are still outstanding, and their
// net effect on each label. Drives the "Changed since lodgement" flag on the BAS list.
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-changes',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const drifts = await getLodgedPeriodDrift()
  const res = NextResponse.json({
    periods: drifts.map((d) => ({
      periodId: d.periodId,
      comparable: d.comparable,
      outstandingCount: d.outstandingCount,
      outstandingTotals: d.outstandingTotals,
    })),
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
