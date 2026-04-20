import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'
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

  const [expenseGroups, bankTransactions, splitLines, journalEntries, salesIncomeEntries, debitNormalAccounts, settings] = await Promise.all([
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
    // Fetch IDs of debit-normal accounts so we can apply the correct sign for bank transactions / split lines
    prisma.account.findMany({ where: { type: { in: ['ASSET', 'EXPENSE', 'COGS'] } }, select: { id: true } }),
    prisma.salesSettings.findUnique({ where: { id: 'default' }, select: { taxRatePercent: true } }),
  ])

  const balances: Record<string, number> = {}
  const taxRatePercent = settings?.taxRatePercent ?? 10

  for (const g of expenseGroups) {
    if (g.accountId) {
      balances[g.accountId] = (balances[g.accountId] ?? 0) + (g._sum.amountExGst ?? 0)
    }
  }

  // For debit-normal accounts (ASSET, EXPENSE, COGS) a bank credit (positive amountCents, money in)
  // reduces the account balance, so we negate after stripping GST. For credit-normal accounts
  // (INCOME, LIABILITY, EQUITY) the ex-GST signed amount is already correct.
  const debitNormalSet = new Set(debitNormalAccounts.map((a: { id: string }) => a.id))

  for (const transaction of bankTransactions) {
    if (!transaction.accountId) continue

    const exGst = amountExcludingGst(transaction.amountCents, transaction.taxCode, taxRatePercent)
    const contribution = debitNormalSet.has(transaction.accountId) ? -exGst : exGst
    balances[transaction.accountId] = (balances[transaction.accountId] ?? 0) + contribution
  }

  // SplitLine.amountCents follows the same sign convention as bank transactions.
  for (const splitLine of splitLines) {
    const exGst = amountExcludingGst(splitLine.amountCents, splitLine.taxCode, taxRatePercent)
    const contribution = debitNormalSet.has(splitLine.accountId) ? -exGst : exGst
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
    select: { coaAccountId: true, id: true },
  }) as { coaAccountId: string; id: string }[]

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
  }

  const res = NextResponse.json({ balances })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
