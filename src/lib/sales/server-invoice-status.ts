import type { Prisma } from '@prisma/client'
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

async function getSalesTaxRatePercent(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.salesSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
    select: { taxRatePercent: true },
  })
  const rate = Number(row?.taxRatePercent)
  return Number.isFinite(rate) ? rate : 10
}

// Single source of truth for how much has been paid against an invoice:
// manual/QuickBooks payments counted toward the balance, plus Stripe mirror
// rows (source=STRIPE). Reading Stripe money from the mirrors — rather than
// SalesInvoiceStripePayment — keeps status consistent with the dashboard
// rollup and accounting cash receipts, and lets deleted test payments drop out.
async function aggregatePaidCents(
  tx: Prisma.TransactionClient,
  invoiceId: string
): Promise<{ paidCents: number }> {
  const agg = await tx.salesPayment.aggregate({
    where: {
      invoiceId,
      OR: [{ excludeFromInvoiceBalance: false }, { source: 'STRIPE' as any }],
    },
    _sum: { amountCents: true },
  })
  const paid = Number(agg?._sum?.amountCents ?? 0)
  return { paidCents: Number.isFinite(paid) ? Math.max(0, Math.trunc(paid)) : 0 }
}

export async function recomputeInvoiceStoredStatus(
  tx: Prisma.TransactionClient,
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
      taxEnabled: true,
      version: true,
    },
  })
  if (!inv) return null

  // VOID is terminal: never recompute or write a revision for a voided invoice,
  // otherwise a later payment recompute could silently un-void it.
  if ((inv.status as InvoiceStatus) === 'VOID') {
    const { paidCents } = await aggregatePaidCents(tx, id)

    const taxRatePercent = await getSalesTaxRatePercent(tx)
    const items = Array.isArray(inv.itemsJson) ? inv.itemsJson : []
    const invTaxEnabled = typeof inv.taxEnabled === 'boolean' ? inv.taxEnabled : true
    const totalCents = sumLineItemsSubtotal(items as any) + (invTaxEnabled ? sumLineItemsTax(items as any, taxRatePercent) : 0)

    return { status: 'VOID', paidCents, totalCents }
  }

  const taxRatePercent = await getSalesTaxRatePercent(tx)
  const items = Array.isArray(inv.itemsJson) ? inv.itemsJson : []
  const invTaxEnabled = typeof inv.taxEnabled === 'boolean' ? inv.taxEnabled : true

  const subtotalCents = sumLineItemsSubtotal(items as any)
  const taxCents = invTaxEnabled ? sumLineItemsTax(items as any, taxRatePercent) : 0
  const totalCents = subtotalCents + taxCents

  const { paidCents } = await aggregatePaidCents(tx, id)

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
