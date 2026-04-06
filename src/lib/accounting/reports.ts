/**
 * Financial Reports — Profit & Loss and Balance Sheet
 *
 * Both reports are calculated live from the database.
 * All figures are returned in cents.
 */

import { prisma } from '@/lib/db'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import type { SalesLineItem } from '@/lib/sales/types'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReportLine {
  accountId: string
  code: string
  name: string
  amountCents: number
}

interface ReportSection {
  label: string
  lines: ReportLine[]
  totalCents: number
}

export interface ProfitLossReport {
  fromDate: string
  toDate: string
  basis: 'CASH' | 'ACCRUAL'
  currency: string
  income: Array<{ accountId: string | null; accountCode: string | null; accountName: string; amountCents: number }>
  totalIncomeCents: number
  cogs: Array<{ accountId: string | null; accountCode: string | null; accountName: string; amountCents: number }>
  grossProfitCents: number
  expenses: Array<{ accountId: string | null; accountCode: string | null; accountName: string; amountCents: number }>
  netProfitCents: number
  totalCogsAndExpensesCents: number
}

export interface BalanceSheetReport {
  asAt: string
  currency: string
  assets: Array<{ accountId?: string | null; accountCode?: string | null; label: string; amountCents: number }>
  totalAssetsCents: number
  liabilities: Array<{ accountId?: string | null; accountCode?: string | null; label: string; amountCents: number }>
  totalLiabilitiesCents: number
  equity: Array<{ accountId?: string | null; accountCode?: string | null; label: string; amountCents: number }>
  totalEquityCents: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByAccount(
  expenses: Array<{ accountId: string; amountIncGst: number; account: { code: string; name: string; type: string } | null }>
): ReportLine[] {
  const map = new Map<string, ReportLine>()
  for (const exp of expenses) {
    if (!exp.account) continue
    const existing = map.get(exp.accountId)
    if (existing) {
      existing.amountCents += exp.amountIncGst
    } else {
      map.set(exp.accountId, {
        accountId: exp.accountId,
        code: exp.account.code,
        name: exp.account.name,
        amountCents: exp.amountIncGst,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code))
}

// ── Profit & Loss ─────────────────────────────────────────────────────────────

export async function buildProfitLossReport(
  startDate: string,
  endDate: string,
  basis: 'CASH' | 'ACCRUAL'
): Promise<ProfitLossReport> {
  // ── Income from SalesInvoices ──────────────────────────────────────────────
  let incomeLines: ReportLine[] = []
  let totalIncomeCents = 0

  const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' } })
  const taxRatePercent = settings?.taxRatePercent ?? 10

  if (basis === 'ACCRUAL') {
    const invoices = await prisma.salesInvoice.findMany({
      where: {
        status: { in: ['OPEN', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'] },
        issueDate: { gte: startDate, lte: endDate },
      },
      select: { itemsJson: true, taxEnabled: true },
    })

    totalIncomeCents = invoices.reduce((sum: number, inv) => {
      const items = (inv.itemsJson as SalesLineItem[]) ?? []
      return sum + sumLineItemsSubtotal(items)
    }, 0)
  } else {
    // Cash: sum payments in period (ex-GST portion)
    const payments = await prisma.salesPayment.findMany({
      where: { paymentDate: { gte: startDate, lte: endDate }, excludeFromInvoiceBalance: false },
      include: { invoice: { select: { itemsJson: true, taxEnabled: true } } },
    })

    totalIncomeCents = payments.reduce((sum: number, pay) => {
      const inv = pay.invoice
      if (!inv) return sum + pay.amountCents
      const items = (inv.itemsJson as SalesLineItem[]) ?? []
      const subtotalCents = sumLineItemsSubtotal(items)
      const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
      const totalCents = subtotalCents + taxCents
      const gstFraction = totalCents > 0 ? taxCents / totalCents : 0
      return sum + pay.amountCents - Math.round(pay.amountCents * gstFraction)
    }, 0)
  }

  incomeLines = [{ accountId: 'sales', code: '4-0000', name: 'Sales Revenue', amountCents: totalIncomeCents }]

  // ── Other Income from bank transactions, journal entries, splits posted to INCOME accounts ──
  const [incomeBankTxns, incomeJournals, incomeSplits] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        status: 'MATCHED',
        matchType: { in: ['MANUAL'] },
        account: { type: 'INCOME' },
      },
      include: { account: { select: { id: true, code: true, name: true, type: true } } },
    }),
    prisma.journalEntry.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        account: { type: 'INCOME' },
      },
      include: { account: { select: { id: true, code: true, name: true, type: true } } },
    }),
    prisma.splitLine.findMany({
      where: {
        bankTransaction: { date: { gte: startDate, lte: endDate }, status: 'MATCHED' },
        account: { type: 'INCOME' },
      },
      include: { account: { select: { id: true, code: true, name: true, type: true } } },
    }),
  ])

  const otherIncomeMap = new Map<string, ReportLine>()
  for (const t of incomeBankTxns) {
    if (!t.account) continue
    const existing = otherIncomeMap.get(t.accountId!)
    if (existing) { existing.amountCents += t.amountCents } else {
      otherIncomeMap.set(t.accountId!, { accountId: t.accountId!, code: t.account.code, name: t.account.name, amountCents: t.amountCents })
    }
  }
  for (const j of incomeJournals) {
    if (!j.account) continue
    const existing = otherIncomeMap.get(j.accountId)
    if (existing) { existing.amountCents += j.amountCents } else {
      otherIncomeMap.set(j.accountId, { accountId: j.accountId, code: j.account.code, name: j.account.name, amountCents: j.amountCents })
    }
  }
  for (const s of incomeSplits) {
    if (!s.account) continue
    const existing = otherIncomeMap.get(s.accountId)
    if (existing) { existing.amountCents += s.amountCents } else {
      otherIncomeMap.set(s.accountId, { accountId: s.accountId, code: s.account.code, name: s.account.name, amountCents: s.amountCents })
    }
  }

  const otherIncomeLines = Array.from(otherIncomeMap.values()).sort((a, b) => a.code.localeCompare(b.code))
  incomeLines = [...incomeLines, ...otherIncomeLines]
  totalIncomeCents += otherIncomeLines.reduce((s, l) => s + l.amountCents, 0)

  // ── COGS ────────────────────────────────────────────────────────────────────
  const cogsExpenses = await prisma.expense.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
      status: { in: ['APPROVED', 'RECONCILED'] },
      account: { type: 'COGS' },
    },
    include: { account: { select: { code: true, name: true, type: true } } },
  })

  const cogsLines = groupByAccount(cogsExpenses as any[])
  const totalCogsCents = cogsLines.reduce((s, l) => s + l.amountCents, 0)
  const grossProfitCents = totalIncomeCents - totalCogsCents

  // ── Expenses ────────────────────────────────────────────────────────────────
  const opExpenses = await prisma.expense.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
      status: { in: ['APPROVED', 'RECONCILED'] },
      account: { type: 'EXPENSE' },
    },
    include: { account: { select: { code: true, name: true, type: true } } },
  })

  const expenseLines = groupByAccount(opExpenses as any[])
  const totalExpenseCents = expenseLines.reduce((s, l) => s + l.amountCents, 0)
  const netProfitCents = grossProfitCents - totalExpenseCents

  return {
    fromDate: startDate,
    toDate: endDate,
    basis,
    currency: 'AUD',
    income: incomeLines.map(l => ({ accountId: l.accountId, accountCode: l.code, accountName: l.name, amountCents: l.amountCents })),
    totalIncomeCents,
    cogs: cogsLines.map(l => ({ accountId: l.accountId, accountCode: l.code, accountName: l.name, amountCents: l.amountCents })),
    grossProfitCents,
    expenses: expenseLines.map(l => ({ accountId: l.accountId, accountCode: l.code, accountName: l.name, amountCents: l.amountCents })),
    netProfitCents,
    totalCogsAndExpensesCents: totalCogsCents + totalExpenseCents,
  }
}

// ── Balance Sheet ─────────────────────────────────────────────────────────────

export async function buildBalanceSheetReport(asOf: string): Promise<BalanceSheetReport> {
  const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' } })
  const taxRatePercent = settings?.taxRatePercent ?? 10

  // Assets: bank account balances (opening balance + net transactions to date)
  const bankAccounts = await prisma.bankAccount.findMany({
    where: { isActive: true },
    include: {
      transactions: {
        where: { date: { lte: asOf }, status: { not: 'EXCLUDED' } },
        select: { amountCents: true },
      },
    },
  })

  const assetLines: ReportLine[] = bankAccounts.map(ba => {
    const balance = ba.openingBalance + ba.transactions.reduce((s, t) => s + t.amountCents, 0)
    return { accountId: ba.id, code: '1-0000', name: ba.name, amountCents: balance }
  })

  // Accounts Receivable: unpaid / partially-paid invoices (accrue based on issue date)
  const outstandingInvoices = await prisma.salesInvoice.findMany({
    where: {
      issueDate: { lte: asOf },
      status: { in: ['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID'] },
    },
    select: { itemsJson: true, taxEnabled: true, payments: { select: { amountCents: true } } },
  })
  let arCents = 0
  for (const inv of outstandingInvoices) {
    const items = (inv.itemsJson as SalesLineItem[]) ?? []
    const subtotalCents = sumLineItemsSubtotal(items)
    const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
    const totalCents = subtotalCents + taxCents
    const paidCents = inv.payments.reduce((s, p) => s + p.amountCents, 0)
    arCents += Math.max(0, totalCents - paidCents)
  }
  if (arCents > 0) {
    assetLines.push({ accountId: 'ar', code: '1-1000', name: 'Accounts Receivable', amountCents: arCents })
  }

  const totalAssetsCents = assetLines.reduce((s, l) => s + l.amountCents, 0)

  // Liabilities: Accounts Payable = unpaid approved expenses to date
  const unpaidExpenses = await prisma.expense.findMany({
    where: {
      date: { lte: asOf },
      status: 'APPROVED',
    },
    select: { amountIncGst: true },
  })
  const apCents = unpaidExpenses.reduce((s, e) => s + e.amountIncGst, 0)

  // Accumulated net profit (all time up to asOf) as equity
  const allExpenses = await prisma.expense.findMany({
    where: { date: { lte: asOf }, status: { in: ['APPROVED', 'RECONCILED'] } },
    select: { amountIncGst: true, gstAmount: true },
  })
  const totalExpCents = allExpenses.reduce((s, e) => s + e.amountIncGst, 0)

  const allPayments = await prisma.salesPayment.findMany({
    where: { paymentDate: { lte: asOf }, excludeFromInvoiceBalance: false },
    include: { invoice: { select: { itemsJson: true, taxEnabled: true } } },
  })
  const totalRevCents = allPayments.reduce((s: number, pay) => {
    const inv = pay.invoice
    if (!inv) return s + pay.amountCents
    const items = (inv.itemsJson as SalesLineItem[]) ?? []
    const subtotalCents = sumLineItemsSubtotal(items)
    const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
    const totalCents = subtotalCents + taxCents
    const gstFraction = totalCents > 0 ? taxCents / totalCents : 0
    return s + pay.amountCents - Math.round(pay.amountCents * gstFraction)
  }, 0)

  const retainedEarningsCents = totalRevCents - totalExpCents

  const liabilityLines: ReportLine[] = [
    { accountId: 'ap', code: '2-1000', name: 'Accounts Payable', amountCents: apCents },
  ]

  // GST liability: GST collected on sales minus GST credits on expenses (all time to asOf)
  const gstExpenses = await prisma.expense.findMany({
    where: { date: { lte: asOf }, status: { in: ['APPROVED', 'RECONCILED'] }, taxCode: 'GST' },
    select: { gstAmount: true },
  })
  const gstCreditsCents = gstExpenses.reduce((s, e) => s + e.gstAmount, 0)

  // GST collected: from all payments received to date (prorate GST)
  let gstCollectedCents = 0
  for (const pay of allPayments) {
    const inv = pay.invoice
    if (!inv) continue
    const items = (inv.itemsJson as SalesLineItem[]) ?? []
    const subtotalCents = sumLineItemsSubtotal(items)
    const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
    const totalCents = subtotalCents + taxCents
    if (totalCents > 0) {
      gstCollectedCents += Math.round((pay.amountCents * taxCents) / totalCents)
    }
  }

  const netGstCents = gstCollectedCents - gstCreditsCents
  if (netGstCents > 0) {
    liabilityLines.push({ accountId: 'gst_payable', code: '2-2000', name: 'GST Payable', amountCents: netGstCents })
  } else if (netGstCents < 0) {
    // GST refund owed to business — show as negative liability (or could be an asset)
    liabilityLines.push({ accountId: 'gst_payable', code: '2-2000', name: 'GST Receivable', amountCents: netGstCents })
  }

  const totalLiabilitiesCents = liabilityLines.reduce((s, l) => s + l.amountCents, 0)

  const equityLines: ReportLine[] = [
    { accountId: 'retained', code: '3-1000', name: 'Retained Earnings', amountCents: retainedEarningsCents },
  ]
  const totalEquityCents = equityLines.reduce((s, l) => s + l.amountCents, 0)

  const netAssetsCents = totalAssetsCents - totalLiabilitiesCents

  return {
    asAt: asOf,
    currency: 'AUD',
    assets: assetLines.map(l => ({ accountId: l.accountId, accountCode: l.code, label: l.name, amountCents: l.amountCents })),
    totalAssetsCents,
    liabilities: liabilityLines.map(l => ({ accountId: l.accountId, accountCode: l.code, label: l.name, amountCents: l.amountCents })),
    totalLiabilitiesCents,
    equity: equityLines.map(l => ({ accountId: l.accountId, accountCode: l.code, label: l.name, amountCents: l.amountCents })),
    totalEquityCents,
  }
}
