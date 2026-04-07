import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/accounting/unmatched-expenses
// Returns expenses that haven't yet been linked to a bank transaction — used by the
// "Match Expense" dialog in the Bank Accounts / Transactions view.
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 120, message: 'Too many requests.' },
    'admin-accounting-unmatched-expenses',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim()

  const rows = await prisma.expense.findMany({
    where: {
      bankTransactionId: null,
      status: { in: ['DRAFT', 'APPROVED'] },
      ...(q
        ? {
            OR: [
              { description: { contains: q, mode: 'insensitive' } },
              { supplierName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: { account: { select: { id: true, code: true, name: true } } },
    orderBy: { date: 'desc' },
    take: 50,
  })

  const expenses = rows.map((r) => ({
    id: r.id,
    date: r.date,
    supplierName: r.supplierName ?? null,
    description: r.description,
    accountName: r.account.name,
    accountCode: r.account.code,
    taxCode: r.taxCode,
    amountIncGstCents: r.amountIncGst,
    status: r.status,
  }))

  const res = NextResponse.json({ expenses })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
