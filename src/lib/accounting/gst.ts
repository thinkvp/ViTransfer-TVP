/**
 * GST / BAS Calculation Engine
 *
 * Calculates all BAS labels for a given date range using Income/Expense data
 * from the Chart of Accounts.
 *
 * BAS Labels calculated:
 *  G1  — Total sales (inc GST)
 *  G2  — Export sales (GST-free, override only)
 *  G3  — Other GST-free sales
 *  G4  — Input-taxed sales
 *  G9  — GST on sales (1A)
 *  G10 — Capital purchases (inc GST)
 *  G11 — Non-capital purchases (inc GST)
 *  1A  — GST collected (= G9)
 *  1B  — GST credits (input tax credits claimed)
 *  Net — GST payable or refundable
 *
 * Data sources (mirrors the P&L report and account ledger):
 *  Sales side:    SalesInvoice (accrual) / SalesPayment (cash), plus MANUAL bank
 *                 transactions, journal entries and split lines posted to INCOME accounts.
 *  Purchase side: Expense records, plus MANUAL bank transactions, journal entries
 *                 and split lines posted to EXPENSE/COGS accounts.
 *
 * Basis rules:
 *  CASH    — sales from payments received in the period; expense GST credits are
 *            claimable only when PAID, so only RECONCILED expenses count, dated by
 *            the bank transaction that paid them.
 *  ACCRUAL — sales from invoices issued in the period; APPROVED + RECONCILED
 *            expenses by expense date.
 */

import { prisma } from '@/lib/db'
import { getSalesTaxRate } from '@/lib/settings'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'
import type { SalesLineItem } from '@/lib/sales/types'
import type { BasSalesRecord, BasExpenseRecord } from '@/lib/accounting/types'
import { cashReceiptReportingAmountCents } from '@/lib/accounting/sales-cash-receipts'

export interface BasCalculation {
  // Sales (GST on sales)
  g1TotalSalesCents: number
  g2ExportSalesCents: number      // Override only
  g3OtherGstFreeCents: number
  g4InputTaxedSalesCents: number
  label1ACents: number            // 1A = GST on sales
  // Purchases (GST credits)
  g10CapitalPurchasesCents: number
  g11NonCapitalPurchasesCents: number
  label1BCents: number            // 1B = GST credits
  // Net
  netGstCents: number             // 1A - 1B (positive = payable, negative = refund)
  // Supporting data
  totalIncomeCents: number
  totalExpenseCents: number
  basis: 'CASH' | 'ACCRUAL'
  startDate: string
  endDate: string
}

export interface BasIssue {
  severity: 'warning' | 'info'
  code: string
  message: string
  count?: number
}

export interface BasCalculationResult {
  calculation: BasCalculation
  issues: BasIssue[]
  records: {
    sales: BasSalesRecord[]
    expenses: BasExpenseRecord[]
  }
}

// ── Internal shapes ──────────────────────────────────────────────────────────

/** A purchase-side item from any source, normalised for classification. */
interface PurchaseItem {
  id: string
  date: string
  supplier: string | null
  description: string
  accountCode: string
  accountName: string
  amountIncGstCents: number
  /** GST stored at entry time (Expense rows); null = derive from the current rate */
  storedGstCents: number | null
  taxCode: string
  isCapital: boolean
  kind: BasExpenseRecord['kind']
  bankTransactionId?: string
}

/** An income posting (non-invoice income) from the Chart of Accounts ledger. */
interface IncomePostingItem {
  id: string
  date: string
  description: string
  amountIncGstCents: number
  taxCode: string
  kind: 'bankTransaction' | 'journal' | 'splitLine'
  bankTransactionId?: string
}

// ── Calculation ──────────────────────────────────────────────────────────────

export async function calculateBas(
  startDate: string,
  endDate: string,
  basis: 'CASH' | 'ACCRUAL',
  g2Override: number | null,
  g3Override: number | null
): Promise<BasCalculationResult> {
  const issues: BasIssue[] = []

  const taxRatePercent = await getSalesTaxRate()

  /** GST portion of a GST-inclusive amount (sign-aware rounding). */
  const gstPortion = (amountIncGstCents: number) =>
    amountIncGstCents - amountExcludingGst(amountIncGstCents, 'GST', taxRatePercent)

  // ── Expenses ──────────────────────────────────────────────────────────────
  // CASH basis: GST credits are claimable when the purchase is paid, so only
  // RECONCILED expenses count, dated by the bank transaction that paid them.
  // ACCRUAL basis: APPROVED + RECONCILED expenses by expense date.
  const expenseInclude = {
    account: { select: { type: true, subType: true, name: true, code: true } },
    bankTransaction: { select: { date: true } },
  } as const

  const expenses = basis === 'CASH'
    ? await prisma.expense.findMany({
        where: {
          status: 'RECONCILED',
          OR: [
            { bankTransaction: { date: { gte: startDate, lte: endDate } } },
            { bankTransactionId: null, date: { gte: startDate, lte: endDate } },
          ],
        },
        include: expenseInclude,
      })
    : await prisma.expense.findMany({
        where: {
          date: { gte: startDate, lte: endDate },
          status: { in: ['APPROVED', 'RECONCILED'] },
        },
        include: expenseInclude,
      })

  // The BAS engine uses the same data sources as the P&L report and ledger:
  // 1. Expense records (above)
  // 2. MANUAL BankTransactions on income/expense/COGS accounts
  // 3. JournalEntry records on income/expense/COGS accounts
  // 4. SplitLine records on income/expense/COGS accounts (split bank transactions)
  const [manualTxns, journalEntries, splitLines] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        status: 'MATCHED',
        matchType: 'MANUAL',
        accountId: { not: null },
        taxCode: { not: null },
        account: { type: { in: ['INCOME', 'EXPENSE', 'COGS'] } },
      },
      include: { account: { select: { type: true, subType: true, name: true, code: true } } },
    }),
    prisma.journalEntry.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        account: { type: { in: ['INCOME', 'EXPENSE', 'COGS'] } },
      },
      include: { account: { select: { type: true, subType: true, name: true, code: true } } },
    }),
    prisma.splitLine.findMany({
      where: {
        bankTransaction: { date: { gte: startDate, lte: endDate }, status: 'MATCHED' },
        account: { type: { in: ['INCOME', 'EXPENSE', 'COGS'] } },
      },
      include: {
        account: { select: { type: true, subType: true, name: true, code: true } },
        bankTransaction: { select: { date: true, description: true } },
      },
    }),
  ])

  const incomeTxns = manualTxns.filter((t) => t.account?.type === 'INCOME')
  const expenseTxns = manualTxns.filter((t) => t.account?.type !== 'INCOME')
  const incomeJournals = journalEntries.filter((j) => j.account?.type === 'INCOME')
  const expenseJournals = journalEntries.filter((j) => j.account?.type !== 'INCOME')
  const incomeSplits = splitLines.filter((s) => s.account?.type === 'INCOME')
  const expenseSplits = splitLines.filter((s) => s.account?.type !== 'INCOME')

  // ── Sales totals ──────────────────────────────────────────────────────────
  let totalSalesCents = 0
  let gstOnSalesCents = 0
  let gstFreeSalesCents = 0
  let inputTaxedSalesCents = 0
  let paymentsWithoutInvoiceCount = 0
  const salesRecords: BasSalesRecord[] = []

  if (basis === 'ACCRUAL') {
    const accrualInvoices = await prisma.salesInvoice.findMany({
      where: {
        // Matches the accrual P&L: every issued invoice except VOID
        status: { in: ['OPEN', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'] },
        issueDate: { gte: startDate, lte: endDate },
      },
      select: {
        id: true,
        invoiceNumber: true,
        issueDate: true,
        itemsJson: true,
        taxEnabled: true,
        client: { select: { name: true } },
      },
    })
    for (const inv of accrualInvoices) {
      const items = (inv.itemsJson as SalesLineItem[]) ?? []
      const subtotalCents = sumLineItemsSubtotal(items)
      const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
      totalSalesCents += subtotalCents + taxCents
      gstOnSalesCents += taxCents
      if (!inv.taxEnabled) gstFreeSalesCents += subtotalCents
      salesRecords.push({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clientName: inv.client?.name ?? 'Unknown',
        date: inv.issueDate,
        subtotalCents,
        gstCents: taxCents,
        totalIncGstCents: subtotalCents + taxCents,
        taxEnabled: inv.taxEnabled,
      })
    }
  } else {
    // Cash basis — single query covering manual payments and Stripe payments (source=STRIPE)
    const invoiceSelect = {
      id: true, invoiceNumber: true, itemsJson: true, taxEnabled: true,
      client: { select: { name: true } },
    } as const

    const allPayments = await prisma.salesPayment.findMany({
      where: {
        paymentDate: { gte: startDate, lte: endDate },
        OR: [
          { excludeFromInvoiceBalance: false },
          { source: 'STRIPE' },
        ],
      },
      include: { invoice: { select: invoiceSelect } },
    })

    type RichReceipt = {
      paymentDate: string; amountCents: number
      invoice: { id: string; invoiceNumber: string; itemsJson: unknown; taxEnabled: boolean; client: { name: string } | null } | null
    }
    const allReceipts: RichReceipt[] = allPayments.map((p) => ({
      paymentDate: p.paymentDate as string,
      amountCents: Math.trunc(p.amountCents),
      invoice: p.invoice ? { id: p.invoice.id, invoiceNumber: p.invoice.invoiceNumber, itemsJson: p.invoice.itemsJson, taxEnabled: p.invoice.taxEnabled, client: p.invoice.client } : null,
    }))

    for (const receipt of allReceipts) {
      const invSnapshot = receipt.invoice ? { itemsJson: receipt.invoice.itemsJson, taxEnabled: receipt.invoice.taxEnabled } : null
      const reportingCents = cashReceiptReportingAmountCents(receipt.amountCents, invSnapshot, taxRatePercent, false)
      const gstCents = receipt.amountCents - reportingCents
      totalSalesCents += receipt.amountCents
      gstOnSalesCents += gstCents
      if (receipt.invoice && !receipt.invoice.taxEnabled) gstFreeSalesCents += receipt.amountCents
      if (!receipt.invoice) paymentsWithoutInvoiceCount++
      salesRecords.push({
        id: receipt.invoice?.id ?? receipt.paymentDate,
        invoiceNumber: receipt.invoice?.invoiceNumber ?? '—',
        clientName: receipt.invoice?.client?.name ?? 'Unknown',
        date: receipt.paymentDate,
        subtotalCents: reportingCents,
        gstCents,
        totalIncGstCents: receipt.amountCents,
        taxEnabled: receipt.invoice?.taxEnabled ?? true,
      })
    }
  }

  // ── Non-invoice income postings (bank transactions / journals / splits) ──
  // Sign conventions: bank transactions & split lines use bank-statement convention
  // (positive = money in = income); journals use accounting convention
  // (negative = credit = income increase), so negate.
  const incomePostings: IncomePostingItem[] = [
    ...incomeTxns.map((t) => ({
      id: t.id,
      date: t.date as string,
      description: t.memo ?? t.description,
      amountIncGstCents: t.amountCents,
      taxCode: t.taxCode as string,
      kind: 'bankTransaction' as const,
      bankTransactionId: t.id,
    })),
    ...incomeJournals.map((j) => ({
      id: j.id,
      date: j.date as string,
      description: j.description,
      amountIncGstCents: -j.amountCents,
      taxCode: j.taxCode as string,
      kind: 'journal' as const,
    })),
    ...incomeSplits.map((s) => ({
      id: s.id,
      date: (s.bankTransaction?.date as string) ?? '',
      description: s.description || s.bankTransaction?.description || '',
      amountIncGstCents: s.amountCents,
      taxCode: s.taxCode as string,
      kind: 'splitLine' as const,
      bankTransactionId: s.bankTransactionId,
    })),
  ]

  for (const posting of incomePostings) {
    // BAS-excluded income postings are out of scope for GST reporting entirely
    if (posting.taxCode === 'BAS_EXCLUDED') continue
    const gstCents = posting.taxCode === 'GST' ? gstPortion(posting.amountIncGstCents) : 0
    totalSalesCents += posting.amountIncGstCents
    gstOnSalesCents += gstCents
    if (posting.taxCode === 'GST_FREE') gstFreeSalesCents += posting.amountIncGstCents
    else if (posting.taxCode === 'INPUT_TAXED') inputTaxedSalesCents += posting.amountIncGstCents
    salesRecords.push({
      id: posting.id,
      invoiceNumber: '—',
      clientName: posting.description,
      date: posting.date,
      subtotalCents: posting.amountIncGstCents - gstCents,
      gstCents,
      totalIncGstCents: posting.amountIncGstCents,
      taxEnabled: posting.taxCode === 'GST',
      kind: posting.kind,
      bankTransactionId: posting.bankTransactionId,
    })
  }

  salesRecords.sort((a, b) => a.date.localeCompare(b.date))

  // ── Expense totals & records ───────────────────────────────────────────────
  // Sign conventions: Expense rows store positive amounts; bank transactions and
  // split lines use bank-statement convention (negative = money out = purchase),
  // so negate; journals use accounting convention (positive = debit = expense).
  const purchaseItems: PurchaseItem[] = [
    ...expenses.map((exp) => ({
      id: exp.id,
      // On cash basis the claimable date is the payment (bank transaction) date
      date: basis === 'CASH'
        ? ((exp.bankTransaction?.date as string | undefined) ?? (exp.date as string))
        : (exp.date as string),
      supplier: exp.supplierName ?? null,
      description: exp.description,
      accountCode: exp.account?.code ?? '',
      accountName: exp.account?.name ?? '',
      amountIncGstCents: exp.amountIncGst,
      storedGstCents: exp.gstAmount,
      taxCode: exp.taxCode as string,
      isCapital: exp.account?.subType?.toLowerCase().includes('capital') ?? false,
      kind: 'expense' as const,
    })),
    ...expenseTxns.map((txn) => ({
      id: txn.id,
      date: txn.date as string,
      supplier: null,
      description: txn.memo ?? txn.description,
      accountCode: txn.account?.code ?? '',
      accountName: txn.account?.name ?? '',
      amountIncGstCents: -txn.amountCents,
      storedGstCents: null,
      taxCode: txn.taxCode as string,
      isCapital: txn.account?.subType?.toLowerCase().includes('capital') ?? false,
      kind: 'bankTransaction' as const,
      bankTransactionId: txn.id,
    })),
    ...expenseJournals.map((je) => ({
      id: je.id,
      date: je.date as string,
      supplier: null,
      description: je.description,
      accountCode: je.account?.code ?? '',
      accountName: je.account?.name ?? '',
      amountIncGstCents: je.amountCents,
      storedGstCents: null,
      taxCode: je.taxCode as string,
      isCapital: je.account?.subType?.toLowerCase().includes('capital') ?? false,
      kind: 'journal' as const,
    })),
    ...expenseSplits.map((sl) => ({
      id: sl.id,
      date: (sl.bankTransaction?.date as string) ?? '',
      supplier: null,
      description: sl.description,
      accountCode: sl.account?.code ?? '',
      accountName: sl.account?.name ?? '',
      amountIncGstCents: -sl.amountCents,
      storedGstCents: null,
      taxCode: sl.taxCode as string,
      isCapital: sl.account?.subType?.toLowerCase().includes('capital') ?? false,
      kind: 'splitLine' as const,
      bankTransactionId: sl.bankTransactionId,
    })),
  ]

  let capitalPurchasesCents = 0
  let nonCapitalPurchasesCents = 0
  let gstCreditsCents = 0
  let totalExpenseCents = 0
  const expenseRecords: BasExpenseRecord[] = []
  let zeroGstCount = 0

  for (const item of purchaseItems) {
    const gstAmt = item.storedGstCents ?? (item.taxCode === 'GST' ? gstPortion(item.amountIncGstCents) : 0)
    let issue: BasExpenseRecord['issue'] = null

    totalExpenseCents += item.amountIncGstCents

    if (item.taxCode === 'GST') {
      gstCreditsCents += gstAmt
      if (item.isCapital) { capitalPurchasesCents += item.amountIncGstCents } else { nonCapitalPurchasesCents += item.amountIncGstCents }
      if (gstAmt === 0 && item.amountIncGstCents !== 0) { issue = 'zero_gst'; zeroGstCount++ }
    } else if (item.taxCode === 'BAS_EXCLUDED') {
      // Out of scope for GST (wages, super, loan repayments) — not reported at G10/G11
      issue = 'bas_excluded'
    } else {
      // GST_FREE / INPUT_TAXED purchases are reportable at G10/G11 without credits
      if (item.isCapital) { capitalPurchasesCents += item.amountIncGstCents } else { nonCapitalPurchasesCents += item.amountIncGstCents }
      if (item.taxCode === 'INPUT_TAXED') issue = 'input_taxed'
    }

    expenseRecords.push({
      id: item.id,
      date: item.date,
      supplier: item.supplier,
      description: item.description,
      accountCode: item.accountCode,
      accountName: item.accountName,
      amountIncGstCents: item.amountIncGstCents,
      gstCents: gstAmt,
      taxCode: item.taxCode,
      isCapital: item.isCapital,
      issue,
      kind: item.kind,
      ...(item.bankTransactionId ? { bankTransactionId: item.bankTransactionId } : {}),
    })
  }

  expenseRecords.sort((a, b) => a.date.localeCompare(b.date))

  const g2ExportSalesCents = g2Override ?? 0
  const g3OtherGstFreeCents = g3Override ?? gstFreeSalesCents
  const g4InputTaxedSalesCents = inputTaxedSalesCents
  const label1ACents = gstOnSalesCents
  const label1BCents = gstCreditsCents
  const netGstCents = gstOnSalesCents - gstCreditsCents

  // ── Validation issues ─────────────────────────────────────────────────────
  const draftExpenseCount = await prisma.expense.count({
    where: { date: { gte: startDate, lte: endDate }, status: 'DRAFT' },
  })
  if (draftExpenseCount > 0) {
    issues.push({ severity: 'warning', code: 'DRAFT_EXPENSES', message: `${draftExpenseCount} expense${draftExpenseCount === 1 ? '' : 's'} still in DRAFT — not included in this BAS.`, count: draftExpenseCount })
  }

  if (basis === 'CASH') {
    // APPROVED = awaiting payment (see Accounts Payable). On cash basis their GST
    // credits are claimable only once paid, so they are excluded from this BAS.
    const approvedUnpaidCount = await prisma.expense.count({
      where: { status: 'APPROVED', date: { lte: endDate } },
    })
    if (approvedUnpaidCount > 0) {
      issues.push({
        severity: 'warning',
        code: 'APPROVED_UNPAID_EXPENSES',
        message: `${approvedUnpaidCount} approved expense${approvedUnpaidCount === 1 ? ' is' : 's are'} not yet paid (not reconciled to a bank transaction) — on cash basis GST credits are claimable only when paid, so ${approvedUnpaidCount === 1 ? 'it is' : 'they are'} not included in this BAS.`,
        count: approvedUnpaidCount,
      })
    }
  }

  if (paymentsWithoutInvoiceCount > 0) {
    issues.push({
      severity: 'warning',
      code: 'PAYMENTS_WITHOUT_INVOICE',
      message: `${paymentsWithoutInvoiceCount} payment${paymentsWithoutInvoiceCount === 1 ? ' is' : 's are'} not linked to an invoice and contribute${paymentsWithoutInvoiceCount === 1 ? 's' : ''} $0 GST to 1A. Link ${paymentsWithoutInvoiceCount === 1 ? 'it' : 'them'} to an invoice or confirm ${paymentsWithoutInvoiceCount === 1 ? 'it is' : 'they are'} GST-free.`,
      count: paymentsWithoutInvoiceCount,
    })
  }

  if (totalSalesCents === 0) {
    issues.push({ severity: 'info', code: 'NO_SALES', message: 'No sales income found for this period. Check invoices are dated within the BAS period.' })
  }

  if (zeroGstCount > 0) {
    issues.push({ severity: 'warning', code: 'ZERO_GST_EXPENSE', message: `${zeroGstCount} expense${zeroGstCount === 1 ? '' : 's'} coded GST but have $0 GST amount — possible data entry error.`, count: zeroGstCount })
  }

  const basExcludedCount = expenseRecords.filter((r) => r.issue === 'bas_excluded').length
  if (basExcludedCount > 0) {
    issues.push({ severity: 'info', code: 'BAS_EXCLUDED_EXPENSES', message: `${basExcludedCount} expense${basExcludedCount === 1 ? '' : 's'} marked BAS Excluded (wages, super, loan repayments) — excluded from G10/G11. Confirm they are correctly classified.`, count: basExcludedCount })
  }

  const gstFreeSalesCount = salesRecords.filter((r) => !r.taxEnabled).length
  if (gstFreeSalesCount > 0) {
    issues.push({ severity: 'info', code: 'GST_FREE_SALES', message: `${gstFreeSalesCount} sale${gstFreeSalesCount === 1 ? '' : 's'} have GST disabled. Confirm these supplies are correctly classified as GST-free.`, count: gstFreeSalesCount })
  }

  const calculation: BasCalculation = {
    g1TotalSalesCents: totalSalesCents,
    g2ExportSalesCents,
    g3OtherGstFreeCents,
    g4InputTaxedSalesCents,
    label1ACents,
    g10CapitalPurchasesCents: capitalPurchasesCents,
    g11NonCapitalPurchasesCents: nonCapitalPurchasesCents,
    label1BCents,
    netGstCents,
    totalIncomeCents: totalSalesCents,
    totalExpenseCents,
    basis,
    startDate,
    endDate,
  }

  return { calculation, issues, records: { sales: salesRecords, expenses: expenseRecords } }
}
