import { prisma } from '@/lib/db'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import type { SalesLineItem } from '@/lib/sales/types'

type InvoiceSnapshot = {
  itemsJson: unknown
  taxEnabled: boolean
}

export type SalesCashReceipt = {
  paymentDate: string
  amountCents: number
  invoice: InvoiceSnapshot | null
}

export function cashReceiptReportingAmountCents(
  amountCents: number,
  invoice: InvoiceSnapshot | null,
  taxRatePercent: number,
  includeGst: boolean
): number {
  if (includeGst || !invoice) return amountCents

  const items = (invoice.itemsJson as SalesLineItem[]) ?? []
  const subtotalCents = sumLineItemsSubtotal(items)
  const taxCents = invoice.taxEnabled ? sumLineItemsTax(items, taxRatePercent) : 0
  const totalCents = subtotalCents + taxCents

  if (totalCents <= 0 || taxCents <= 0) return amountCents

  return amountCents - Math.round((amountCents * taxCents) / totalCents)
}

export async function listSalesCashReceiptsInRange(startDate: string, endDate: string): Promise<SalesCashReceipt[]> {
  const payments = await prisma.salesPayment.findMany({
    where: {
      paymentDate: { gte: startDate, lte: endDate },
      OR: [
        { excludeFromInvoiceBalance: false },
        { source: 'STRIPE' },
      ],
    },
    include: {
      invoice: {
        select: { itemsJson: true, taxEnabled: true },
      },
    },
  })

  return payments.map((payment) => ({
    paymentDate: payment.paymentDate,
    amountCents: Math.max(0, Math.trunc(payment.amountCents)),
    invoice: payment.invoice ? { itemsJson: payment.invoice.itemsJson, taxEnabled: payment.invoice.taxEnabled } : null,
  }))
}

export async function listSalesCashReceiptsUpTo(asOf: string): Promise<SalesCashReceipt[]> {
  const payments = await prisma.salesPayment.findMany({
    where: {
      paymentDate: { lte: asOf },
      OR: [
        { excludeFromInvoiceBalance: false },
        { source: 'STRIPE' },
      ],
    },
    include: {
      invoice: {
        select: { itemsJson: true, taxEnabled: true },
      },
    },
  })

  return payments.map((payment) => ({
    paymentDate: payment.paymentDate,
    amountCents: Math.max(0, Math.trunc(payment.amountCents)),
    invoice: payment.invoice ? { itemsJson: payment.invoice.itemsJson, taxEnabled: payment.invoice.taxEnabled } : null,
  }))
}
