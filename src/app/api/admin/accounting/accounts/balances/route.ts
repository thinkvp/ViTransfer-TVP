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

  const [expenseGroups, txnGroups, salesIncomeEntries, debitNormalAccounts] = await Promise.all([
    prisma.expense.groupBy({
      by: ['accountId'],
      where: hasDateFilter ? { date: dateFilter } : {},
      _sum: { amountExGst: true },
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
    // Fetch IDs of debit-normal accounts so we can apply the correct sign for bank transactions
    prisma.account.findMany({ where: { type: { in: ['ASSET', 'EXPENSE', 'COGS'] } }, select: { id: true } }),
  ])

  const balances: Record<string, number> = {}

  for (const g of expenseGroups) {
    if (g.accountId) {
      balances[g.accountId] = (balances[g.accountId] ?? 0) + (g._sum.amountExGst ?? 0)
    }
  }

  // For debit-normal accounts (ASSET, EXPENSE, COGS) a bank credit (positive amountCents, money in)
  // REDUCES the account balance, so we negate. For credit-normal accounts (INCOME, LIABILITY, EQUITY)
  // raw signed amountCents is correct.
  const debitNormalSet = new Set(debitNormalAccounts.map((a: { id: string }) => a.id))

  for (const g of txnGroups) {
    if (g.accountId) {
      const raw = g._sum.amountCents ?? 0
      const contribution = debitNormalSet.has(g.accountId) ? -raw : raw
      balances[g.accountId] = (balances[g.accountId] ?? 0) + contribution
    }
  }

  for (const entry of salesIncomeEntries) {
    balances[entry.accountId] = (balances[entry.accountId] ?? 0) + entry.amountCents
  }

  const res = NextResponse.json({ balances })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
