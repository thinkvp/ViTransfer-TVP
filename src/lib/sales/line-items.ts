import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { SalesLineItem } from '@/lib/sales/types'

const MAX_ITEMS = 200
const MAX_QUANTITY = 1_000_000
const MAX_UNIT_PRICE_CENTS = 2_000_000_000

// Validates the shape of incoming line items without stripping unknown fields
// (labels, accounting hints, etc. ride along untouched via passthrough).
const lineItemSchema = z
  .object({
    id: z.string().trim().max(100).optional(),
    description: z.string().max(2000).optional().default(''),
    details: z.string().max(10000).optional().nullable(),
    quantity: z.number().finite().min(-MAX_QUANTITY).max(MAX_QUANTITY).optional().default(0),
    unitPriceCents: z.number().int().min(-MAX_UNIT_PRICE_CENTS).max(MAX_UNIT_PRICE_CENTS).optional().default(0),
    taxRatePercent: z.number().finite().min(0).max(100).optional(),
    taxRateName: z.string().max(200).optional().nullable(),
  })
  .passthrough()

export const lineItemsSchema = z.array(lineItemSchema).max(MAX_ITEMS)

/**
 * Normalizes validated line items for storage. Items missing an explicit
 * taxRatePercent are stamped with the current default rate so the document's
 * totals are frozen at save time — later changes to the default Sales tax rate
 * must not retroactively change historical quote/invoice totals.
 */
export function normalizeLineItems(
  items: z.infer<typeof lineItemsSchema>,
  defaultTaxRatePercent: number
): SalesLineItem[] {
  const rate = Number.isFinite(defaultTaxRatePercent) ? defaultTaxRatePercent : 10
  return items.map((it, index) => ({
    ...it,
    id: (typeof it.id === 'string' && it.id.trim()) ? it.id : `li-${index + 1}`,
    description: typeof it.description === 'string' ? it.description : '',
    quantity: Number.isFinite(it.quantity) ? it.quantity : 0,
    unitPriceCents: Number.isFinite(it.unitPriceCents) ? Math.trunc(it.unitPriceCents) : 0,
    taxRatePercent: Number.isFinite(it.taxRatePercent as number) ? (it.taxRatePercent as number) : rate,
  })) as SalesLineItem[]
}

export async function getDefaultTaxRatePercent(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.salesSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
    select: { taxRatePercent: true },
  }).catch(() => null)
  const rate = Number(row?.taxRatePercent)
  return Number.isFinite(rate) ? rate : 10
}
