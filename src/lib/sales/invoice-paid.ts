import { prisma } from '@/lib/db'

/**
 * Sum of all payments counted against an invoice's balance, in cents:
 * manual {@link SalesPayment} rows (excluding those flagged
 * `excludeFromInvoiceBalance`) plus Stripe mirror rows (source=STRIPE).
 * Reading Stripe money from the mirrors keeps this consistent with the
 * dashboard rollup and `recomputeInvoiceStoredStatus`, and lets deleted
 * test payments drop out. Best-effort — returns 0 on any error or for a
 * blank id.
 */
export async function aggregateInvoicePaidCents(invoiceId: string): Promise<number> {
  const id = String(invoiceId || '').trim()
  if (!id) return 0

  const agg = await prisma.salesPayment
    .aggregate({
      where: {
        invoiceId: id,
        OR: [{ excludeFromInvoiceBalance: false }, { source: 'STRIPE' as any }],
      },
      _sum: { amountCents: true },
    })
    .catch(() => null)

  const total = Number(agg?._sum?.amountCents ?? 0)
  return Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0
}
