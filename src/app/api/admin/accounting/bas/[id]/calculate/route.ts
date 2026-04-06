import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { basPeriodFromDb } from '@/lib/accounting/db-mappers'
import { calculateBas } from '@/lib/accounting/gst'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/accounting/bas/[id]/calculate
// Runs the BAS calculation engine for this period and returns results (does NOT save figures)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-calculate',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const period = await prisma.basPeriod.findUnique({ where: { id } })

  if (!period) {
    return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  }

  const { calculation, issues } = await calculateBas(
    period.startDate,
    period.endDate,
    period.basis as 'CASH' | 'ACCRUAL',
    period.g2Override,
    period.g3Override
  )

  const res = NextResponse.json({
    period: basPeriodFromDb(period),
    calculation,
    issues,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
