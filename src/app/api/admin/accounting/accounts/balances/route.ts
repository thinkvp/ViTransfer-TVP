import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { listSalesInvoiceIncomeEntries } from '@/lib/accounting/sales-income-allocation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-accounts-balances-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const from = url.searchParams.get('from') ?? undefined
  const to = url.searchParams.get('to') ?? undefined

  const dateFilter: Record<string, string> = {}
  if (from) dateFilter.gte = from
  if (to) dateFilter.lte = to
  const hasDateFilter = from || to

  const [expenseGroups, txnGroups, salesIncomeEntries] = await Promise.all([
    prisma.expense.groupBy({
      by: ['accountId'],
      where: hasDateFilter ? { date: dateFilter } : {},
      _sum: { amountIncGst: true },
    }),
    prisma.bankTransaction.groupBy({
      by: ['accountId'],
      where: {
        status: 'MATCHED',
        matchType: { not: 'INVOICE_PAYMENT' },
        transactionType: { not: 'Expense' },
        accountId: { not: null },
        ...(hasDateFilter ? { date: dateFilter } : {}),
      },
      _sum: { amountCents: true },
    }),
    listSalesInvoiceIncomeEntries({ from, to }),
  ])

  const balances: Record<string, number> = {}

  for (const g of expenseGroups) {
    if (g.accountId) {
      balances[g.accountId] = (balances[g.accountId] ?? 0) + (g._sum.amountIncGst ?? 0)
    }
  }

  for (const g of txnGroups) {
    if (g.accountId) {
      // amountCents is negative for debits, positive for credits — store signed so UI can format correctly
      balances[g.accountId] = (balances[g.accountId] ?? 0) + (g._sum.amountCents ?? 0)
    }
  }

  for (const entry of salesIncomeEntries) {
    balances[entry.accountId] = (balances[entry.accountId] ?? 0) + entry.amountCents
  }

  const res = NextResponse.json({ balances })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
