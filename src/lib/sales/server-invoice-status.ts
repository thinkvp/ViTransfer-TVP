import type { InvoiceStatus } from '@/lib/sales/types'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { salesInvoiceFromDb } from '@/lib/sales/db-mappers'
import {
  endOfDayLocal,
  invoiceEffectiveStatus as computeInvoiceEffectiveStatus,
} from '@/lib/sales/status'

function addDaysLocal(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

async function getSalesTaxRatePercent(tx: any): Promise<number> {
  const row = await tx.salesSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
    select: { taxRatePercent: true },
  })
  const rate = Number(row?.taxRatePercent)
  return Number.isFinite(rate) ? rate : 10
}

export async function recomputeInvoiceStoredStatus(
  tx: any,
  invoiceId: string,
  opts?: { createdByUserId?: string | null; nowMs?: number }
): Promise<{ status: InvoiceStatus; paidCents: number; totalCents: number } | null> {
  const id = String(invoiceId || '').trim()
  if (!id) return null

  const nowMs = typeof opts?.nowMs === 'number' && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()

  const inv = await tx.salesInvoice.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      sentAt: true,
      dueDate: true,
      itemsJson: true,
      version: true,
    },
  })
  if (!inv) return null

  const taxRatePercent = await getSalesTaxRatePercent(tx)
  const items = Array.isArray(inv.itemsJson) ? inv.itemsJson : []

  const subtotalCents = sumLineItemsSubtotal(items as any)
  const taxCents = sumLineItemsTax(items as any, taxRatePercent)
  const totalCents = subtotalCents + taxCents

  const paymentsAgg = await tx.salesPayment.aggregate({
    where: { invoiceId: id, excludeFromInvoiceBalance: false },
    _sum: { amountCents: true },
    _max: { paymentDate: true },
  })

  const stripeAgg = await tx.salesInvoiceStripePayment.aggregate({
    where: { invoiceDocId: id },
    _sum: { invoiceAmountCents: true },
    _max: { createdAt: true },
  })

  const paidLocalCents = Number(paymentsAgg?._sum?.amountCents ?? 0)
  const paidStripeCents = Number(stripeAgg?._sum?.invoiceAmountCents ?? 0)
  const paidCents = Math.max(0, Math.trunc(paidLocalCents + paidStripeCents))

  const nextStatus = computeInvoiceEffectiveStatus(
    {
      status: inv.status as InvoiceStatus,
      sentAt: inv.sentAt,
      dueDate: inv.dueDate,
      totalCents,
      paidCents,
    },
    nowMs
  )

  if (nextStatus !== (inv.status as InvoiceStatus)) {
    const nextVersion = Number(inv.version || 1) + 1

    const updated = await tx.salesInvoice.update({
      where: { id },
      data: {
        status: nextStatus as any,
        version: nextVersion,
      },
    })

    await tx.salesInvoiceRevision.create({
      data: {
        invoiceId: id,
        version: nextVersion,
        docJson: salesInvoiceFromDb(updated as any),
        createdByUserId: opts?.createdByUserId ?? null,
      },
    })
  }

  // Best-effort: refresh any active public share snapshot status.
  try {
    await tx.$executeRaw`
      UPDATE "SalesDocumentShare"
      SET "docJson" = jsonb_set(COALESCE("docJson", '{}'::jsonb), '{status}', to_jsonb(${nextStatus}::text), true)
      WHERE "type" = 'INVOICE'
        AND "docId" = ${id}
        AND "revokedAt" IS NULL
    `

    if (nextStatus === 'PAID') {
      const paidAtIso = new Date(nowMs).toISOString()
      const paidAtYmd = paidAtIso.slice(0, 10)
      const expiresAt = addDaysLocal(endOfDayLocal(new Date(nowMs)), 30)

      await tx.$executeRaw`
        UPDATE "SalesDocumentShare"
        SET "docJson" = jsonb_set(
          jsonb_set(
            jsonb_set(COALESCE("docJson", '{}'::jsonb), '{status}', to_jsonb('PAID'::text), true),
            '{invoicePaidAt}',
            to_jsonb(${paidAtYmd}::text),
            true
          ),
          '{paidAt}',
          to_jsonb(${paidAtIso}::text),
          true
        ),
        "expiresAt" = ${expiresAt}
        WHERE "type" = 'INVOICE'
          AND "docId" = ${id}
          AND "revokedAt" IS NULL
      `
    }
  } catch {
    // ignore
  }

  return { status: nextStatus, paidCents, totalCents }
}
