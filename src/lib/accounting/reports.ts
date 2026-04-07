/**
 * Financial Reports — Profit & Loss and Balance Sheet
 *
 * Both reports are calculated live from the database.
 * All figures are returned in cents.
 */

import { prisma } from '@/lib/db'
import { calcLineSubtotalCents, sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import type { SalesLineItem } from '@/lib/sales/types'
import { cashReceiptReportingAmountCents, listSalesCashReceiptsInRange, listSalesCashReceiptsUpTo } from '@/lib/accounting/sales-cash-receipts'

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

  const settings = await prisma.salesSettings.findUnique({
    where: { id: 'default' },
    include: { defaultIncomeAccount: { select: { id: true, code: true, name: true } } },
  })
  const taxRatePercent = settings?.taxRatePercent ?? 10

  // Build a map of all SalesLabels (id → { accountId, account.code, account.name })
  const allLabels = await prisma.salesLabel.findMany({
    select: { id: true, name: true, accountId: true, account: { select: { code: true, name: true } } },
  })
  const labelAccountMap = new Map(allLabels.map((l) => [l.id, l]))

  // Default income account: falls back to a synthetic "Sales Revenue" line if none configured
  const defaultIncomeAcct = settings?.defaultIncomeAccount
    ? { id: settings.defaultIncomeAccount.id, code: settings.defaultIncomeAccount.code, name: settings.defaultIncomeAccount.name }
    : { id: '__sales_revenue__', code: '4-0000', name: 'Sales Revenue' }

  /** Accumulate a subtotal amount into a keyed map of income lines */
  function addToIncomeMap(map: Map<string, ReportLine>, acctId: string, code: string, name: string, cents: number) {
    const existing = map.get(acctId)
    if (existing) { existing.amountCents += cents }
    else { map.set(acctId, { accountId: acctId, code, name, amountCents: cents }) }
  }

  /** Split an invoice's items by label→account and accumulate into map.
   *  If a receipt amountCents is provided the totals are pro-rated (for cash basis). */
  function splitItemsByLabel(
    map: Map<string, ReportLine>,
    items: SalesLineItem[],
    receiptCents?: number
  ) {
    const invoiceSubtotal = sumLineItemsSubtotal(items)
    for (const item of items) {
      let itemCents = calcLineSubtotalCents(item)
      // For cash basis, prorate this item's share of the receipt
      if (receiptCents !== undefined && invoiceSubtotal > 0) {
        itemCents = Math.round((itemCents / invoiceSubtotal) * receiptCents)
      }
      if (itemCents === 0) continue

      const label = item.labelId ? labelAccountMap.get(item.labelId) : null
      if (label?.accountId && label.account) {
        addToIncomeMap(map, label.accountId, label.account.code, label.account.name, itemCents)
      } else {
        addToIncomeMap(map, defaultIncomeAcct.id, defaultIncomeAcct.code, defaultIncomeAcct.name, itemCents)
      }
    }
  }

  const salesIncomeMap = new Map<string, ReportLine>()

  if (basis === 'ACCRUAL') {
    const invoices = await prisma.salesInvoice.findMany({
      where: {
        status: { in: ['OPEN', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'] },
        issueDate: { gte: startDate, lte: endDate },
      },
      select: { itemsJson: true, taxEnabled: true },
    })
    for (const inv of invoices) {
      splitItemsByLabel(salesIncomeMap, (inv.itemsJson as SalesLineItem[]) ?? [])
    }
  } else {
    // Cash basis: prorate each receipt by item subtotal proportions
    const receipts = await listSalesCashReceiptsInRange(startDate, endDate)
    for (const receipt of receipts) {
      const reportingCents = cashReceiptReportingAmountCents(receipt.amountCents, receipt.invoice, taxRatePercent, false)
      const items = (receipt.invoice?.itemsJson as SalesLineItem[] | undefined) ?? []
      if (items.length === 0) {
        // No invoice snapshot — put everything in default account
        addToIncomeMap(salesIncomeMap, defaultIncomeAcct.id, defaultIncomeAcct.code, defaultIncomeAcct.name, reportingCents)
      } else {
        splitItemsByLabel(salesIncomeMap, items, reportingCents)
      }
    }
  }

  incomeLines = Array.from(salesIncomeMap.values()).sort((a, b) => a.code.localeCompare(b.code))
  totalIncomeCents = incomeLines.reduce((s, l) => s + l.amountCents, 0)

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

  // Merge other income into salesIncomeMap so the same COA account never appears twice
  for (const [acctId, line] of otherIncomeMap) {
    addToIncomeMap(salesIncomeMap, acctId, line.code, line.name, line.amountCents)
  }
  incomeLines = Array.from(salesIncomeMap.values()).sort((a, b) => a.code.localeCompare(b.code))
  totalIncomeCents = incomeLines.reduce((s, l) => s + l.amountCents, 0)

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
    select: { id: true, itemsJson: true, taxEnabled: true, payments: { where: { excludeFromInvoiceBalance: false }, select: { amountCents: true } } },
  })
  const stripePayments = await prisma.salesInvoiceStripePayment.findMany({
    where: { createdAt: { lte: new Date(`${asOf}T23:59:59.999Z`) } },
    select: { invoiceDocId: true, invoiceAmountCents: true },
  })
  const stripePaidByInvoice = new Map<string, number>()
  for (const payment of stripePayments) {
    if (!payment.invoiceDocId) continue
    stripePaidByInvoice.set(payment.invoiceDocId, (stripePaidByInvoice.get(payment.invoiceDocId) ?? 0) + payment.invoiceAmountCents)
  }
  let arCents = 0
  for (const inv of outstandingInvoices) {
    const items = (inv.itemsJson as SalesLineItem[]) ?? []
    const subtotalCents = sumLineItemsSubtotal(items)
    const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
    const totalCents = subtotalCents + taxCents
    const paidCents = inv.payments.reduce((s, p) => s + p.amountCents, 0) + (stripePaidByInvoice.get(inv.id) ?? 0)
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

  const allReceipts = await listSalesCashReceiptsUpTo(asOf)
  const totalRevCents = allReceipts.reduce(
    (sum, receipt) => sum + cashReceiptReportingAmountCents(receipt.amountCents, receipt.invoice, taxRatePercent, false),
    0
  )

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
  for (const receipt of allReceipts) {
    gstCollectedCents += receipt.amountCents - cashReceiptReportingAmountCents(receipt.amountCents, receipt.invoice, taxRatePercent, false)
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

// ── Trial Balance ─────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  accountId: string
  code: string
  name: string
  type: string
  debitCents: number
  creditCents: number
}

export interface TrialBalanceReport {
  asAt: string
  currency: string
  rows: TrialBalanceRow[]
  totalDebitCents: number
  totalCreditCents: number
}

export async function buildTrialBalanceReport(asOf: string): Promise<TrialBalanceReport> {
  const accounts = await prisma.account.findMany({
    where: { isActive: true },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, type: true },
  })

  const rows: TrialBalanceRow[] = []

  for (const acct of accounts) {
    // Sum all entries posted to this account up to asOf
    const [expenses, bankTxns, journals, splits, salesEntries] = await Promise.all([
      prisma.expense.aggregate({
        where: { accountId: acct.id, date: { lte: asOf }, status: { in: ['APPROVED', 'RECONCILED'] } },
        _sum: { amountIncGst: true },
      }),
      prisma.bankTransaction.aggregate({
        where: { accountId: acct.id, date: { lte: asOf }, status: 'MATCHED' },
        _sum: { amountCents: true },
      }),
      prisma.journalEntry.aggregate({
        where: { accountId: acct.id, date: { lte: asOf } },
        _sum: { amountCents: true },
      }),
      prisma.splitLine.aggregate({
        where: { accountId: acct.id, bankTransaction: { date: { lte: asOf }, status: 'MATCHED' } },
        _sum: { amountCents: true },
      }),
      // Sales invoice allocations to this account (via label mapping) are already
      // captured in income lines from P&L; skip to keep trial balance simple for now.
      Promise.resolve(0),
    ])

    const total =
      (expenses._sum.amountIncGst ?? 0) +
      (bankTxns._sum.amountCents ?? 0) +
      (journals._sum.amountCents ?? 0) +
      (splits._sum.amountCents ?? 0)

    if (total === 0) continue

    // Debit-normal accounts: ASSET, EXPENSE, COGS
    // Credit-normal accounts: LIABILITY, EQUITY, INCOME
    const isDebitNormal = ['ASSET', 'EXPENSE', 'COGS'].includes(acct.type)
    const debitCents = isDebitNormal ? Math.max(0, total) : Math.max(0, -total)
    const creditCents = isDebitNormal ? Math.max(0, -total) : Math.max(0, total)

    rows.push({
      accountId: acct.id,
      code: acct.code,
      name: acct.name,
      type: acct.type,
      debitCents,
      creditCents,
    })
  }

  const totalDebitCents = rows.reduce((s, r) => s + r.debitCents, 0)
  const totalCreditCents = rows.reduce((s, r) => s + r.creditCents, 0)

  return { asAt: asOf, currency: 'AUD', rows, totalDebitCents, totalCreditCents }
}

// ── Aged Receivables ──────────────────────────────────────────────────────────

export interface AgedReceivablesRow {
  clientName: string
  clientId: string | null
  invoiceId: string
  invoiceNumber: string
  issueDate: string
  dueDate: string | null
  totalCents: number
  paidCents: number
  outstandingCents: number
  agingBucket: 'current' | '30' | '60' | '90'
}

export interface AgedReceivablesReport {
  asAt: string
  currency: string
  rows: AgedReceivablesRow[]
  currentCents: number
  over30Cents: number
  over60Cents: number
  over90Cents: number
  totalOutstandingCents: number
}

export async function buildAgedReceivablesReport(asOf: string): Promise<AgedReceivablesReport> {
  const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' } })
  const taxRatePercent = settings?.taxRatePercent ?? 10

  const invoices = await prisma.salesInvoice.findMany({
    where: {
      issueDate: { lte: asOf },
      status: { in: ['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID'] },
    },
    include: {
      client: { select: { id: true, name: true } },
      payments: { where: { excludeFromInvoiceBalance: false }, select: { amountCents: true } },
    },
    orderBy: { issueDate: 'asc' },
  })

  // Stripe payments
  const stripePayments = await prisma.salesInvoiceStripePayment.findMany({
    where: { createdAt: { lte: new Date(`${asOf}T23:59:59.999Z`) } },
    select: { invoiceDocId: true, invoiceAmountCents: true },
  })
  const stripePaidByInvoice = new Map<string, number>()
  for (const p of stripePayments) {
    if (!p.invoiceDocId) continue
    stripePaidByInvoice.set(p.invoiceDocId, (stripePaidByInvoice.get(p.invoiceDocId) ?? 0) + p.invoiceAmountCents)
  }

  const asOfDate = new Date(`${asOf}T00:00:00`)
  const rows: AgedReceivablesRow[] = []
  let currentCents = 0
  let over30Cents = 0
  let over60Cents = 0
  let over90Cents = 0

  for (const inv of invoices) {
    const items = (inv.itemsJson as SalesLineItem[]) ?? []
    const subtotalCents = sumLineItemsSubtotal(items)
    const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
    const totalCents = subtotalCents + taxCents
    const paidCents = inv.payments.reduce((s, p) => s + p.amountCents, 0) + (stripePaidByInvoice.get(inv.id) ?? 0)
    const outstandingCents = Math.max(0, totalCents - paidCents)

    if (outstandingCents <= 0) continue

    // Aging based on due date (or issue date if no due date)
    const refDateStr = inv.dueDate ?? inv.issueDate
    const refDate = new Date(`${refDateStr}T00:00:00`)
    const daysOverdue = Math.max(0, Math.floor((asOfDate.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24)))

    let bucket: AgedReceivablesRow['agingBucket']
    if (daysOverdue > 90) { bucket = '90'; over90Cents += outstandingCents }
    else if (daysOverdue > 60) { bucket = '60'; over60Cents += outstandingCents }
    else if (daysOverdue > 30) { bucket = '30'; over30Cents += outstandingCents }
    else { bucket = 'current'; currentCents += outstandingCents }

    rows.push({
      clientName: inv.client?.name ?? 'Unknown',
      clientId: inv.clientId,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber ?? inv.id.slice(0, 8),
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      totalCents,
      paidCents,
      outstandingCents,
      agingBucket: bucket,
    })
  }

  return {
    asAt: asOf,
    currency: 'AUD',
    rows,
    currentCents,
    over30Cents,
    over60Cents,
    over90Cents,
    totalOutstandingCents: currentCents + over30Cents + over60Cents + over90Cents,
  }
}
