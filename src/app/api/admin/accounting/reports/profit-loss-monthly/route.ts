import { NextRequest, NextResponse } from 'next/server'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
import { sumLineItemsSubtotal } from '@/lib/sales/money'
import type { SalesLineItem } from '@/lib/sales/types'
import { listSalesCashReceiptsInRange, cashReceiptReportingAmountCents } from '@/lib/accounting/sales-cash-receipts'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'
import { expenseReportingDate, expenseReportingDateWhere } from '@/lib/accounting/expense-reporting'
import { getAccountingReportingBasis } from '@/lib/accounting/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Helpers ───────────────────────────────────────────────────────────────────

function ym(date: string): string {
  return date.slice(0, 7)
}

function enumerateMonths(from: string, to: string): string[] {
  const months: string[] = []
  const [fromY, fromM] = from.split('-').map(Number)
  const [toY, toM] = to.split('-').map(Number)
  let y = fromY
  let m = fromM
  while (y < toY || (y === toY && m <= toM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return months
}

interface MonthBucket {
  incomeCents: number
  cogsCents: number
  expenseCents: number
}

async function resolveEarliestProfitLossDate(to: string): Promise<string | null> {
  const [firstInvoice, firstPayment, firstExpense, firstManualBankTxn, firstJournal, firstSplitBankTxn] = await Promise.all([
    prisma.salesInvoice.findFirst({
      where: {
        status: { in: ['OPEN', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'] },
        issueDate: { lte: to },
      },
      orderBy: { issueDate: 'asc' },
      select: { issueDate: true },
    }),
    prisma.salesPayment.findFirst({
      where: {
        paymentDate: { lte: to },
        OR: [
          { excludeFromInvoiceBalance: false },
          { source: 'STRIPE' },
        ],
      },
      orderBy: { paymentDate: 'asc' },
      select: { paymentDate: true },
    }),
    prisma.expense.findFirst({
      where: {
        date: { lte: to },
        status: { in: ['APPROVED', 'RECONCILED'] },
        account: { type: { in: ['COGS', 'EXPENSE'] } },
      },
      orderBy: { date: 'asc' },
      select: { date: true },
    }),
    prisma.bankTransaction.findFirst({
      where: {
        date: { lte: to },
        status: 'MATCHED',
        matchType: 'MANUAL',
        account: { type: { in: ['INCOME', 'COGS', 'EXPENSE'] } },
      },
      orderBy: { date: 'asc' },
      select: { date: true },
    }),
    prisma.journalEntry.findFirst({
      where: {
        date: { lte: to },
        account: { type: { in: ['INCOME', 'COGS', 'EXPENSE'] } },
      },
      orderBy: { date: 'asc' },
      select: { date: true },
    }),
    prisma.bankTransaction.findFirst({
      where: {
        date: { lte: to },
        status: 'MATCHED',
        splitLines: {
          some: {
            account: { type: { in: ['INCOME', 'COGS', 'EXPENSE'] } },
          },
        },
      },
      orderBy: { date: 'asc' },
      select: { date: true },
    }),
  ])

  const candidates = [
    firstInvoice?.issueDate,
    firstPayment?.paymentDate,
    firstExpense?.date,
    firstManualBankTxn?.date,
    firstJournal?.date,
    firstSplitBankTxn?.date,
  ].filter((d): d is string => Boolean(d))

  if (candidates.length === 0) return null
  candidates.sort()
  return candidates[0]
}

// GET /api/admin/accounting/reports/profit-loss-monthly
// Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, basis=CASH|ACCRUAL
// Returns monthly income/cogs/expenses/netProfit for rendering trend charts on the Accounting Dashboard.
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'admin-accounting-report-pl-monthly',
    authResult.id,
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const fromRaw = searchParams.get('from')
  const to = searchParams.get('to')
  const requestedBasis = searchParams.get('basis')

  if (!fromRaw || !to) {
    return NextResponse.json({ error: 'from and to query params are required (YYYY-MM-DD)' }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'to date must be in YYYY-MM-DD format' }, { status: 400 })
  }
  if (fromRaw !== 'all-time' && !/^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) {
    return NextResponse.json({ error: 'from must be YYYY-MM-DD or all-time' }, { status: 400 })
  }

  const from = fromRaw === 'all-time'
    ? (await resolveEarliestProfitLossDate(to)) ?? to
    : fromRaw

  if (from > to) {
    return NextResponse.json({ error: 'from must be before or equal to to' }, { status: 400 })
  }

  const basis: 'CASH' | 'ACCRUAL' =
    requestedBasis === 'CASH' || requestedBasis === 'ACCRUAL'
      ? requestedBasis
      : await getAccountingReportingBasis()

  const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' } })
  const taxRatePercent = settings?.taxRatePercent ?? 10

  const months = enumerateMonths(from, to)
  const buckets = new Map<string, MonthBucket>(
    months.map((m) => [m, { incomeCents: 0, cogsCents: 0, expenseCents: 0 }]),
  )

  function addTo(key: string, field: keyof MonthBucket, amount: number) {
    const bucket = buckets.get(key)
    if (bucket) bucket[field] += amount
  }

  // ── Income ──────────────────────────────────────────────────────────────────

  if (basis === 'ACCRUAL') {
    const invoices = await prisma.salesInvoice.findMany({
      where: {
        status: { in: ['OPEN', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'] },
        issueDate: { gte: from, lte: to },
      },
      select: { issueDate: true, itemsJson: true },
    })
    for (const inv of invoices) {
      const subtotal = sumLineItemsSubtotal((inv.itemsJson as SalesLineItem[]) ?? [])
      addTo(ym(inv.issueDate), 'incomeCents', subtotal)
    }
  } else {
    const receipts = await listSalesCashReceiptsInRange(from, to)
    for (const r of receipts) {
      const amount = cashReceiptReportingAmountCents(r.amountCents, r.invoice, taxRatePercent, false)
      addTo(ym(r.paymentDate), 'incomeCents', amount)
    }
  }

  // Other income: MANUAL bank transactions, journal entries, split lines posted to INCOME accounts
  const [incomeBankTxns, incomeJournals, incomeSplits] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        date: { gte: from, lte: to },
        status: 'MATCHED',
        matchType: 'MANUAL',
        account: { type: 'INCOME' },
      },
      select: { date: true, amountCents: true, taxCode: true },
    }),
    prisma.journalEntry.findMany({
      where: { date: { gte: from, lte: to }, account: { type: 'INCOME' } },
      select: { date: true, amountCents: true, taxCode: true },
    }),
    prisma.splitLine.findMany({
      where: {
        bankTransaction: { date: { gte: from, lte: to }, status: 'MATCHED' },
        account: { type: 'INCOME' },
      },
      select: { amountCents: true, taxCode: true, bankTransaction: { select: { date: true } } },
    }),
  ])

  for (const t of incomeBankTxns) {
    addTo(ym(t.date), 'incomeCents', amountExcludingGst(t.amountCents, t.taxCode, taxRatePercent))
  }
  for (const j of incomeJournals) {
    // Negate: INCOME is credit-normal, so a credit (negative in journal convention)
    // increases income — matches the range P&L in reports.ts
    addTo(ym(j.date), 'incomeCents', -amountExcludingGst(j.amountCents, j.taxCode, taxRatePercent))
  }
  for (const s of incomeSplits) {
    addTo(ym(s.bankTransaction.date), 'incomeCents', amountExcludingGst(s.amountCents, s.taxCode, taxRatePercent))
  }

  // ── COGS ─────────────────────────────────────────────────────────────────────

  const [cogsExpenses, cogsBankTxns, cogsJournals, cogsSplits] = await Promise.all([
    // Basis-aware: on cash basis expenses count when PAID (bank txn date) — see expense-reporting.ts
    prisma.expense.findMany({
      where: { ...expenseReportingDateWhere(basis, { gte: from, lte: to }), account: { type: 'COGS' } },
      select: { date: true, amountExGst: true, bankTransaction: { select: { date: true } } },
    }),
    prisma.bankTransaction.findMany({
      where: { date: { gte: from, lte: to }, status: 'MATCHED', matchType: 'MANUAL', account: { type: 'COGS' } },
      select: { date: true, amountCents: true, taxCode: true },
    }),
    prisma.journalEntry.findMany({
      where: { date: { gte: from, lte: to }, account: { type: 'COGS' } },
      select: { date: true, amountCents: true, taxCode: true },
    }),
    prisma.splitLine.findMany({
      where: {
        bankTransaction: { date: { gte: from, lte: to }, status: 'MATCHED' },
        account: { type: 'COGS' },
      },
      select: { amountCents: true, taxCode: true, bankTransaction: { select: { date: true } } },
    }),
  ])

  for (const e of cogsExpenses) addTo(ym(expenseReportingDate(e, basis)), 'cogsCents', e.amountExGst)
  for (const t of cogsBankTxns) addTo(ym(t.date), 'cogsCents', -amountExcludingGst(t.amountCents, t.taxCode, taxRatePercent))
  for (const j of cogsJournals) addTo(ym(j.date), 'cogsCents', amountExcludingGst(j.amountCents, j.taxCode, taxRatePercent))
  for (const s of cogsSplits) addTo(ym(s.bankTransaction.date), 'cogsCents', -amountExcludingGst(s.amountCents, s.taxCode, taxRatePercent))

  // ── Operating Expenses ────────────────────────────────────────────────────────

  const [opExpenses, opBankTxns, opJournals, opSplits] = await Promise.all([
    prisma.expense.findMany({
      where: { ...expenseReportingDateWhere(basis, { gte: from, lte: to }), account: { type: 'EXPENSE' } },
      select: { date: true, amountExGst: true, bankTransaction: { select: { date: true } } },
    }),
    prisma.bankTransaction.findMany({
      where: { date: { gte: from, lte: to }, status: 'MATCHED', matchType: 'MANUAL', account: { type: 'EXPENSE' } },
      select: { date: true, amountCents: true, taxCode: true },
    }),
    prisma.journalEntry.findMany({
      where: { date: { gte: from, lte: to }, account: { type: 'EXPENSE' } },
      select: { date: true, amountCents: true, taxCode: true },
    }),
    prisma.splitLine.findMany({
      where: {
        bankTransaction: { date: { gte: from, lte: to }, status: 'MATCHED' },
        account: { type: 'EXPENSE' },
      },
      select: { amountCents: true, taxCode: true, bankTransaction: { select: { date: true } } },
    }),
  ])

  for (const e of opExpenses) addTo(ym(expenseReportingDate(e, basis)), 'expenseCents', e.amountExGst)
  for (const t of opBankTxns) addTo(ym(t.date), 'expenseCents', -amountExcludingGst(t.amountCents, t.taxCode, taxRatePercent))
  for (const j of opJournals) addTo(ym(j.date), 'expenseCents', amountExcludingGst(j.amountCents, j.taxCode, taxRatePercent))
  for (const s of opSplits) addTo(ym(s.bankTransaction.date), 'expenseCents', -amountExcludingGst(s.amountCents, s.taxCode, taxRatePercent))

  // ── Build response ────────────────────────────────────────────────────────────

  const result = months.map((month) => {
    const b = buckets.get(month)!
    return {
      yearMonth: month,
      incomeCents: b.incomeCents,
      cogsCents: b.cogsCents,
      expenseCents: b.expenseCents,
      netProfitCents: b.incomeCents - b.cogsCents - b.expenseCents,
    }
  })

  const res = NextResponse.json({ months: result, basis })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
