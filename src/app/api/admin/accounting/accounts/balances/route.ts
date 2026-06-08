import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'
import { listSalesInvoiceIncomeEntries } from '@/lib/accounting/sales-income-allocation'
import { getSalesTaxRate } from '@/lib/settings'

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

  const [expenseGroups, bankTransactions, splitLines, journalEntries, salesIncomeEntries, expenseNormalAccounts, taxRatePercentRaw] = await Promise.all([
    prisma.expense.groupBy({
      by: ['accountId'],
      where: hasDateFilter ? { date: dateFilter } : {},
      _sum: { amountExGst: true },
    }),
    prisma.bankTransaction.findMany({
      select: { accountId: true, amountCents: true, taxCode: true },
      where: {
        status: 'MATCHED',
        matchType: { not: 'INVOICE_PAYMENT' },
        transactionType: { not: 'Expense' },
        accountId: { not: null },
        ...(hasDateFilter ? { date: dateFilter } : {}),
      },
    }),
    prisma.splitLine.findMany({
      select: { accountId: true, amountCents: true, taxCode: true },
      where: {
        bankTransaction: {
          status: 'MATCHED',
          ...(hasDateFilter ? { date: dateFilter } : {}),
        },
      },
    }),
    prisma.journalEntry.findMany({
      select: { accountId: true, amountCents: true, taxCode: true },
      where: hasDateFilter ? { date: dateFilter } : {},
    }),
    listSalesInvoiceIncomeEntries({ from, to }),
    // Only EXPENSE/COGS need the bank-transaction sign flip (withdrawal → increase expense).
    // ASSET accounts use raw bank-statement sign (deposit = increase, no flip).
    prisma.account.findMany({ where: { type: { in: ['EXPENSE', 'COGS'] } }, select: { id: true } }),
    getSalesTaxRate(),
  ])

  const balances: Record<string, number> = {}
  const taxRatePercent = taxRatePercentRaw ?? 10

  for (const g of expenseGroups) {
    if (g.accountId) {
      balances[g.accountId] = (balances[g.accountId] ?? 0) + (g._sum.amountExGst ?? 0)
    }
  }

  // Bank transactions follow bank-statement convention (positive = money in).
  // Only EXPENSE/COGS need the sign flip (a withdrawal -$100 = money out = should
  // increase the expense balance).  ASSET, INCOME, LIABILITY, EQUITY use raw sign.
  const expenseNormalSet = new Set(expenseNormalAccounts.map((a: { id: string }) => a.id))

  for (const transaction of bankTransactions) {
    if (!transaction.accountId) continue

    const exGst = amountExcludingGst(transaction.amountCents, transaction.taxCode, taxRatePercent)
    const contribution = expenseNormalSet.has(transaction.accountId) ? -exGst : exGst
    balances[transaction.accountId] = (balances[transaction.accountId] ?? 0) + contribution
  }

  // SplitLine.amountCents follows the same sign convention as bank transactions.
  for (const splitLine of splitLines) {
    const exGst = amountExcludingGst(splitLine.amountCents, splitLine.taxCode, taxRatePercent)
    const contribution = expenseNormalSet.has(splitLine.accountId) ? -exGst : exGst
    balances[splitLine.accountId] = (balances[splitLine.accountId] ?? 0) + contribution
  }

  // Journal entries are already signed from the account's perspective.
  for (const journalEntry of journalEntries) {
    const exGst = amountExcludingGst(journalEntry.amountCents, journalEntry.taxCode, taxRatePercent)
    balances[journalEntry.accountId] = (balances[journalEntry.accountId] ?? 0) + exGst
  }

  for (const entry of salesIncomeEntries) {
    balances[entry.accountId] = (balances[entry.accountId] ?? 0) + entry.amountCents
  }

  // For ASSET accounts linked to a bank account (coaAccountId), sum all non-EXCLUDED
  // bank transactions from that bank account as raw cash amounts for the CoA balance.
  // coaAccountId column is added by a pending migration; cast to bypass stale Prisma client types.
  const linkedBankAccounts = await (prisma.bankAccount.findMany as Function)({
    where: { coaAccountId: { not: null } },
    select: { coaAccountId: true, id: true, openingBalance: true },
  }) as { coaAccountId: string; id: string; openingBalance: number }[]

  if (linkedBankAccounts.length > 0) {
    const bankAccountIds = linkedBankAccounts.map(ba => ba.id)
    const linkedTxns = await prisma.bankTransaction.findMany({
      select: { bankAccountId: true, amountCents: true },
      where: {
        bankAccountId: { in: bankAccountIds },
        status: { not: 'EXCLUDED' },
        ...(hasDateFilter ? { date: dateFilter } : {}),
      },
    })
    const coaByBankAccountId = Object.fromEntries(linkedBankAccounts.map(ba => [ba.id, ba.coaAccountId]))
    for (const txn of linkedTxns) {
      const coaId = coaByBankAccountId[txn.bankAccountId]
      if (!coaId) continue
      balances[coaId] = (balances[coaId] ?? 0) + Number(txn.amountCents)
    }
    // Always include the opening balance — it is the account's starting point and must
    // be reflected in the CoA balance regardless of the selected date range filter.
    for (const ba of linkedBankAccounts) {
      balances[ba.coaAccountId] = (balances[ba.coaAccountId] ?? 0) + Number(ba.openingBalance)
    }
  }

  const res = NextResponse.json({ balances })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
