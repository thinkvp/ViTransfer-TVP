import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { basPeriodFromDb } from '@/lib/accounting/db-mappers'
import { getAccountingReportingBasis } from '@/lib/accounting/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  label: z.string().trim().min(1).max(100),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quarter: z.number().int().min(1).max(4),
  financialYear: z.string().trim().min(1).max(20),
  notes: z.string().trim().max(5000).optional().nullable(),
})

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const periods = await prisma.basPeriod.findMany({
    orderBy: [{ financialYear: 'desc' }, { quarter: 'desc' }],
  })

  const res = NextResponse.json({ periods: periods.map(basPeriodFromDb) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const d = parsed.data
  const reportingBasis = await getAccountingReportingBasis()

  if (d.startDate >= d.endDate) {
    return NextResponse.json({ error: 'startDate must be before endDate' }, { status: 400 })
  }

  const period = await prisma.basPeriod.create({
    data: {
      label: d.label,
      startDate: d.startDate,
      endDate: d.endDate,
      quarter: d.quarter,
      financialYear: d.financialYear,
      basis: reportingBasis,
      notes: d.notes ?? null,
    },
  })

  const res = NextResponse.json({ period: basPeriodFromDb(period) }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
