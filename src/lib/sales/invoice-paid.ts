import { prisma } from '@/lib/db'

/**
 * Sum of all payments counted against an invoice's balance, in cents:
 * manual {@link SalesPayment} rows (excluding those flagged
 * `excludeFromInvoiceBalance`) plus Stripe payments. Best-effort — returns 0 on
 * any error or for a blank id. Mirrors the aggregation in
 * `recomputeInvoiceStoredStatus`.
 */
export async function aggregateInvoicePaidCents(invoiceId: string): Promise<number> {
  const id = String(invoiceId || '').trim()
  if (!id) return 0

  const [localAgg, stripeAgg] = await Promise.all([
    prisma.salesPayment
      .aggregate({ where: { invoiceId: id, excludeFromInvoiceBalance: false }, _sum: { amountCents: true } })
      .catch(() => null),
    prisma.salesInvoiceStripePayment
      .aggregate({ where: { invoiceDocId: id }, _sum: { invoiceAmountCents: true } })
      .catch(() => null),
  ])

  const local = Number(localAgg?._sum?.amountCents ?? 0)
  const stripe = Number(stripeAgg?._sum?.invoiceAmountCents ?? 0)
  const total = (Number.isFinite(local) ? local : 0) + (Number.isFinite(stripe) ? stripe : 0)
  return Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0
}
