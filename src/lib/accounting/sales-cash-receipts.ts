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

function startOfDay(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`)
}

function endOfDay(value: string): Date {
  return new Date(`${value}T23:59:59.999Z`)
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
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
  const [localPayments, stripePayments] = await Promise.all([
    prisma.salesPayment.findMany({
      where: {
        paymentDate: { gte: startDate, lte: endDate },
        excludeFromInvoiceBalance: false,
      },
      include: {
        invoice: {
          select: { itemsJson: true, taxEnabled: true },
        },
      },
    }),
    prisma.salesInvoiceStripePayment.findMany({
      where: {
        createdAt: {
          gte: startOfDay(startDate),
          lte: endOfDay(endDate),
        },
      },
      select: {
        invoiceDocId: true,
        invoiceAmountCents: true,
        createdAt: true,
      },
    }),
  ])

  const stripeInvoiceIds = Array.from(new Set(stripePayments.map((payment) => payment.invoiceDocId).filter(Boolean)))
  const stripeInvoices = stripeInvoiceIds.length
    ? await prisma.salesInvoice.findMany({
        where: { id: { in: stripeInvoiceIds } },
        select: { id: true, itemsJson: true, taxEnabled: true },
      })
    : []

  const stripeInvoiceMap = new Map(stripeInvoices.map((invoice) => [invoice.id, { itemsJson: invoice.itemsJson, taxEnabled: invoice.taxEnabled }]))

  return [
    ...localPayments.map((payment) => ({
      paymentDate: payment.paymentDate,
      amountCents: Math.max(0, Math.trunc(payment.amountCents)),
      invoice: payment.invoice ? { itemsJson: payment.invoice.itemsJson, taxEnabled: payment.invoice.taxEnabled } : null,
    })),
    ...stripePayments.map((payment) => ({
      paymentDate: toIsoDate(payment.createdAt),
      amountCents: Math.max(0, Math.trunc(payment.invoiceAmountCents)),
      invoice: payment.invoiceDocId ? stripeInvoiceMap.get(payment.invoiceDocId) ?? null : null,
    })),
  ]
}

export async function listSalesCashReceiptsUpTo(asOf: string): Promise<SalesCashReceipt[]> {
  const [localPayments, stripePayments] = await Promise.all([
    prisma.salesPayment.findMany({
      where: {
        paymentDate: { lte: asOf },
        excludeFromInvoiceBalance: false,
      },
      include: {
        invoice: {
          select: { itemsJson: true, taxEnabled: true },
        },
      },
    }),
    prisma.salesInvoiceStripePayment.findMany({
      where: {
        createdAt: { lte: endOfDay(asOf) },
      },
      select: {
        invoiceDocId: true,
        invoiceAmountCents: true,
        createdAt: true,
      },
    }),
  ])

  const stripeInvoiceIds = Array.from(new Set(stripePayments.map((payment) => payment.invoiceDocId).filter(Boolean)))
  const stripeInvoices = stripeInvoiceIds.length
    ? await prisma.salesInvoice.findMany({
        where: { id: { in: stripeInvoiceIds } },
        select: { id: true, itemsJson: true, taxEnabled: true },
      })
    : []

  const stripeInvoiceMap = new Map(stripeInvoices.map((invoice) => [invoice.id, { itemsJson: invoice.itemsJson, taxEnabled: invoice.taxEnabled }]))

  return [
    ...localPayments.map((payment) => ({
      paymentDate: payment.paymentDate,
      amountCents: Math.max(0, Math.trunc(payment.amountCents)),
      invoice: payment.invoice ? { itemsJson: payment.invoice.itemsJson, taxEnabled: payment.invoice.taxEnabled } : null,
    })),
    ...stripePayments.map((payment) => ({
      paymentDate: toIsoDate(payment.createdAt),
      amountCents: Math.max(0, Math.trunc(payment.invoiceAmountCents)),
      invoice: payment.invoiceDocId ? stripeInvoiceMap.get(payment.invoiceDocId) ?? null : null,
    })),
  ]
}