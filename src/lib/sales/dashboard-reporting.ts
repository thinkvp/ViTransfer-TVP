import type { SalesRollupPaymentRow } from '@/lib/sales/admin-api'
import type { SalesInvoice, SalesSettings } from '@/lib/sales/types'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'

export function getSalesDashboardReportingBasis(settings: SalesSettings): 'CASH' | 'ACCRUAL' {
  return settings.dashboardReportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL'
}

export function salesDashboardIncludesGst(settings: SalesSettings): boolean {
  return settings.dashboardAmountsIncludeGst !== false
}

export function getInvoiceDashboardAmountCents(
  invoice: SalesInvoice,
  taxRatePercent: number,
  includeGst: boolean,
  rollup?: { totalCents?: number | null }
): number {
  const subtotalCents = sumLineItemsSubtotal(invoice.items)
  if (!includeGst) return subtotalCents

  if (rollup?.totalCents != null && Number.isFinite(Number(rollup.totalCents))) {
    return Math.max(0, Math.trunc(Number(rollup.totalCents)))
  }

  const taxCents = invoice.taxEnabled ? sumLineItemsTax(invoice.items, taxRatePercent) : 0
  return subtotalCents + taxCents
}

export function getPaymentDashboardAmountCents(
  payment: Pick<SalesRollupPaymentRow, 'amountCents'>,
  invoice: SalesInvoice | null | undefined,
  taxRatePercent: number,
  includeGst: boolean
): number {
  const amountCents = Math.max(0, Math.trunc(payment.amountCents))
  if (includeGst || !invoice) return amountCents

  const subtotalCents = sumLineItemsSubtotal(invoice.items)
  const taxCents = invoice.taxEnabled ? sumLineItemsTax(invoice.items, taxRatePercent) : 0
  const totalCents = subtotalCents + taxCents

  if (totalCents <= 0 || taxCents <= 0) return amountCents

  return amountCents - Math.round((amountCents * taxCents) / totalCents)
}
