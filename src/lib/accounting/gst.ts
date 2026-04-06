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

  // ── Income (from SalesInvoices) ──────────────────────────────────────────
  // Accrual = issue date, Cash = payment date
  const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' } })
  const taxRatePercent = settings?.taxRatePercent ?? 10

  // ── Expenses ──────────────────────────────────────────────────────────────
  const expenses = await prisma.expense.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
      status: { in: ['APPROVED', 'RECONCILED'] },
    },
    include: { account: { select: { type: true, subType: true } } },
  })

  // ── Sales totals ──────────────────────────────────────────────────────────
  let totalSalesCents = 0
  let gstOnSalesCents = 0
  let gstFreeSalesCents = 0
  let inputTaxedSalesCents = 0

  if (basis === 'ACCRUAL') {
    const accrualInvoices = await prisma.salesInvoice.findMany({
      where: {
        status: { in: ['SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'] },
        issueDate: { gte: startDate, lte: endDate },
      },
      select: { itemsJson: true, taxEnabled: true },
    })
    for (const inv of accrualInvoices) {
      const items = (inv.itemsJson as SalesLineItem[]) ?? []
      const subtotalCents = sumLineItemsSubtotal(items)
      const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
      totalSalesCents += subtotalCents + taxCents
      gstOnSalesCents += taxCents
      if (!inv.taxEnabled) {
        gstFreeSalesCents += subtotalCents
      }
    }
  } else {
    // Cash basis: sum payments in period, prorate GST
    const cashPayments = await prisma.salesPayment.findMany({
      where: { paymentDate: { gte: startDate, lte: endDate }, excludeFromInvoiceBalance: false },
      include: { invoice: { select: { itemsJson: true, taxEnabled: true } } },
    })
    for (const pay of cashPayments) {
      totalSalesCents += pay.amountCents
      const inv = pay.invoice
      if (inv) {
        const items = (inv.itemsJson as SalesLineItem[]) ?? []
        const subtotalCents = sumLineItemsSubtotal(items)
        const taxCents = inv.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
        const totalCents = subtotalCents + taxCents
        if (totalCents > 0) {
          gstOnSalesCents += Math.round((pay.amountCents * taxCents) / totalCents)
        }
        if (!inv.taxEnabled) {
          gstFreeSalesCents += pay.amountCents
        }
      }
    }
  }

  // ── Expense totals ────────────────────────────────────────────────────────
  let capitalPurchasesCents = 0
  let nonCapitalPurchasesCents = 0
  let gstCreditsCents = 0
  let totalExpenseCents = 0

  for (const exp of expenses) {
    totalExpenseCents += exp.amountIncGst
    const isCapital = exp.account?.subType?.toLowerCase().includes('capital') ?? false

    if (exp.taxCode === 'GST') {
      gstCreditsCents += exp.gstAmount
      if (isCapital) {
        capitalPurchasesCents += exp.amountIncGst
      } else {
        nonCapitalPurchasesCents += exp.amountIncGst
      }
    } else if (exp.taxCode === 'GST_FREE' || exp.taxCode === 'BAS_EXCLUDED' || exp.taxCode === 'INPUT_TAXED') {
      nonCapitalPurchasesCents += exp.amountIncGst
    }
  }

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
    issues.push({ severity: 'warning', code: 'DRAFT_EXPENSES', message: 'Some expenses are still in DRAFT status and are not included in this BAS calculation.' })
  }

  if (totalSalesCents === 0) {
    issues.push({ severity: 'info', code: 'NO_SALES', message: 'No sales income found for this period. Check invoices are dated within the BAS period.' })
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

  return { calculation, issues }
}
