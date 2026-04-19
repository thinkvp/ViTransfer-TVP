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
 */

import { prisma } from '@/lib/db'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
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

// ── Calculation ──────────────────────────────────────────────────────────────

export async function calculateBas(
  startDate: string,
  endDate: string,
  basis: 'CASH' | 'ACCRUAL',
  g2Override: number | null,
  g3Override: number | null
): Promise<BasCalculationResult> {
  const issues: BasIssue[] = []

  const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' } })
  const taxRatePercent = settings?.taxRatePercent ?? 10

  // ── Expenses ──────────────────────────────────────────────────────────────
  const expenses = await prisma.expense.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
      status: { in: ['APPROVED', 'RECONCILED'] },
    },
    include: { account: { select: { type: true, subType: true, name: true, code: true } } },
  })

  // The BAS engine uses the same four data sources as the P&L report and ledger:
  // 1. Expense records (above)
  // 2. MANUAL BankTransactions on expense/COGS accounts (refunds posted as Deposit/ReceivePayment)
  // 3. JournalEntry records on expense/COGS accounts (manual adjustments from the ledger page)
  // 4. SplitLine records on expense/COGS accounts (split bank transactions)
  const taxRate = taxRatePercent / 100

  const [manualExpenseTxns, journalExpenseEntries, splitExpenseLines] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        status: 'MATCHED',
        matchType: 'MANUAL',
        accountId: { not: null },
        taxCode: { not: null },
        account: { type: { in: ['EXPENSE', 'COGS'] } },
      },
      include: { account: { select: { type: true, subType: true, name: true, code: true } } },
    }),
    prisma.journalEntry.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        account: { type: { in: ['EXPENSE', 'COGS'] } },
      },
      include: { account: { select: { type: true, subType: true, name: true, code: true } } },
    }),
    prisma.splitLine.findMany({
      where: {
        bankTransaction: { date: { gte: startDate, lte: endDate }, status: 'MATCHED' },
        account: { type: { in: ['EXPENSE', 'COGS'] } },
      },
      include: {
        account: { select: { type: true, subType: true, name: true, code: true } },
        bankTransaction: { select: { date: true, description: true } },
      },
    }),
  ])

  // ── Sales totals ──────────────────────────────────────────────────────────
  let totalSalesCents = 0
  let gstOnSalesCents = 0
  let gstFreeSalesCents = 0
  let inputTaxedSalesCents = 0
  const salesRecords: BasSalesRecord[] = []

  if (basis === 'ACCRUAL') {
    const accrualInvoices = await prisma.salesInvoice.findMany({
      where: {
        status: { in: ['SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'] },
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
      amountCents: Math.max(0, Math.trunc(p.amountCents)),
      invoice: p.invoice ? { id: p.invoice.id, invoiceNumber: p.invoice.invoiceNumber, itemsJson: p.invoice.itemsJson, taxEnabled: p.invoice.taxEnabled, client: p.invoice.client } : null,
    }))

    for (const receipt of allReceipts) {
      const invSnapshot = receipt.invoice ? { itemsJson: receipt.invoice.itemsJson, taxEnabled: receipt.invoice.taxEnabled } : null
      const reportingCents = cashReceiptReportingAmountCents(receipt.amountCents, invSnapshot, taxRatePercent, false)
      const gstCents = receipt.amountCents - reportingCents
      totalSalesCents += receipt.amountCents
      gstOnSalesCents += gstCents
      if (receipt.invoice && !receipt.invoice.taxEnabled) gstFreeSalesCents += receipt.amountCents
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

  salesRecords.sort((a, b) => a.date.localeCompare(b.date))

  // ── Expense totals & records ───────────────────────────────────────────────
  let capitalPurchasesCents = 0
  let nonCapitalPurchasesCents = 0
  let gstCreditsCents = 0
  let totalExpenseCents = 0
  const expenseRecords: BasExpenseRecord[] = []
  let zeroGstCount = 0

  for (const exp of expenses) {
    totalExpenseCents += exp.amountIncGst
    const isCapital = exp.account?.subType?.toLowerCase().includes('capital') ?? false
    const taxCode = exp.taxCode as string
    let issue: BasExpenseRecord['issue'] = null

    if (taxCode === 'GST') {
      gstCreditsCents += exp.gstAmount
      if (isCapital) { capitalPurchasesCents += exp.amountIncGst } else { nonCapitalPurchasesCents += exp.amountIncGst }
      if (exp.gstAmount === 0 && exp.amountIncGst !== 0) { issue = 'zero_gst'; zeroGstCount++ }
    } else {
      nonCapitalPurchasesCents += exp.amountIncGst
      if (taxCode === 'BAS_EXCLUDED') issue = 'bas_excluded'
      else if (taxCode === 'INPUT_TAXED') issue = 'input_taxed'
    }

    expenseRecords.push({
      id: exp.id,
      date: exp.date as string,
      supplier: exp.supplierName ?? null,
      description: exp.description,
      accountCode: exp.account?.code ?? '',
      accountName: exp.account?.name ?? '',
      amountIncGstCents: exp.amountIncGst,
      gstCents: exp.gstAmount,
      taxCode,
      isCapital,
      issue,
      kind: 'expense',
    })
  }

  // Process MANUAL bank transactions posted to expense accounts (refunds / credits).
  // amountCents is positive for credits; negate so the refund reduces expense totals.
  for (const txn of manualExpenseTxns) {
    const amountIncGst = -txn.amountCents
    const txnTaxCode = txn.taxCode as string
    const gstAmt = txnTaxCode === 'GST' ? Math.round(amountIncGst * taxRate / (1 + taxRate)) : 0
    const isCapital = txn.account?.subType?.toLowerCase().includes('capital') ?? false
    let issue: BasExpenseRecord['issue'] = null

    totalExpenseCents += amountIncGst
    if (txnTaxCode === 'GST') {
      gstCreditsCents += gstAmt
      if (isCapital) { capitalPurchasesCents += amountIncGst } else { nonCapitalPurchasesCents += amountIncGst }
      if (gstAmt === 0 && amountIncGst !== 0) { issue = 'zero_gst'; zeroGstCount++ }
    } else {
      nonCapitalPurchasesCents += amountIncGst
      if (txnTaxCode === 'BAS_EXCLUDED') issue = 'bas_excluded'
      else if (txnTaxCode === 'INPUT_TAXED') issue = 'input_taxed'
    }

    expenseRecords.push({
      id: txn.id,
      date: txn.date as string,
      supplier: null,
      description: txn.memo ?? txn.description,
      accountCode: txn.account?.code ?? '',
      accountName: txn.account?.name ?? '',
      amountIncGstCents: amountIncGst,
      gstCents: gstAmt,
      taxCode: txnTaxCode,
      isCapital,
      issue,
      kind: 'bankTransaction',
      bankTransactionId: txn.id,
    })
  }

  // Process JournalEntry records on expense/COGS accounts.
  // amountCents: positive = debit (increases expense normal balance), negative = credit (reduces).
  for (const je of journalExpenseEntries) {
    const amountIncGst = je.amountCents
    const jeTaxCode = je.taxCode as string
    const gstAmt = jeTaxCode === 'GST' ? Math.round(amountIncGst * taxRate / (1 + taxRate)) : 0
    const isCapital = je.account?.subType?.toLowerCase().includes('capital') ?? false
    let issue: BasExpenseRecord['issue'] = null

    totalExpenseCents += amountIncGst
    if (jeTaxCode === 'GST') {
      gstCreditsCents += gstAmt
      if (isCapital) { capitalPurchasesCents += amountIncGst } else { nonCapitalPurchasesCents += amountIncGst }
      if (gstAmt === 0 && amountIncGst !== 0) { issue = 'zero_gst'; zeroGstCount++ }
    } else {
      nonCapitalPurchasesCents += amountIncGst
      if (jeTaxCode === 'BAS_EXCLUDED') issue = 'bas_excluded'
      else if (jeTaxCode === 'INPUT_TAXED') issue = 'input_taxed'
    }

    expenseRecords.push({
      id: je.id,
      date: je.date as string,
      supplier: null,
      description: je.description,
      accountCode: je.account?.code ?? '',
      accountName: je.account?.name ?? '',
      amountIncGstCents: amountIncGst,
      gstCents: gstAmt,
      taxCode: jeTaxCode,
      isCapital,
      issue,
      kind: 'journal',
    })
  }

  // Process SplitLine records on expense/COGS accounts.
  // amountCents mirrors the bank transaction sign: negative = debit (expense), positive = credit (refund).
  // Negate so that a debit split line increases expense totals.
  for (const sl of splitExpenseLines) {
    const amountIncGst = -sl.amountCents
    const slTaxCode = sl.taxCode as string
    const gstAmt = slTaxCode === 'GST' ? Math.round(amountIncGst * taxRate / (1 + taxRate)) : 0
    const isCapital = sl.account?.subType?.toLowerCase().includes('capital') ?? false
    let issue: BasExpenseRecord['issue'] = null

    totalExpenseCents += amountIncGst
    if (slTaxCode === 'GST') {
      gstCreditsCents += gstAmt
      if (isCapital) { capitalPurchasesCents += amountIncGst } else { nonCapitalPurchasesCents += amountIncGst }
      if (gstAmt === 0 && amountIncGst !== 0) { issue = 'zero_gst'; zeroGstCount++ }
    } else {
      nonCapitalPurchasesCents += amountIncGst
      if (slTaxCode === 'BAS_EXCLUDED') issue = 'bas_excluded'
      else if (slTaxCode === 'INPUT_TAXED') issue = 'input_taxed'
    }

    expenseRecords.push({
      id: sl.id,
      date: sl.bankTransaction?.date as string ?? '',
      supplier: null,
      description: sl.description,
      accountCode: sl.account?.code ?? '',
      accountName: sl.account?.name ?? '',
      amountIncGstCents: amountIncGst,
      gstCents: gstAmt,
      taxCode: slTaxCode,
      isCapital,
      issue,
      kind: 'splitLine',
      bankTransactionId: sl.bankTransactionId,
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

  if (totalSalesCents === 0) {
    issues.push({ severity: 'info', code: 'NO_SALES', message: 'No sales income found for this period. Check invoices are dated within the BAS period.' })
  }

  if (zeroGstCount > 0) {
    issues.push({ severity: 'warning', code: 'ZERO_GST_EXPENSE', message: `${zeroGstCount} expense${zeroGstCount === 1 ? '' : 's'} coded GST but have $0 GST amount — possible data entry error.`, count: zeroGstCount })
  }

  const basExcludedCount = expenseRecords.filter((r) => r.issue === 'bas_excluded').length
  if (basExcludedCount > 0) {
    issues.push({ severity: 'info', code: 'BAS_EXCLUDED_EXPENSES', message: `${basExcludedCount} expense${basExcludedCount === 1 ? '' : 's'} marked BAS Excluded (wages, super, loan repayments). Confirm they are correctly classified.`, count: basExcludedCount })
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
