/**
 * Label arithmetic for BAS changes and prior-period adjustments. Pure (no database), so the
 * BAS pages can use it as well as bas-adjustments.ts.
 */

import type { BasLabelDeltas } from '@/lib/accounting/types'

const LABEL_KEYS = ['g1Cents', 'g3Cents', 'g4Cents', 'g10Cents', 'g11Cents', 'label1ACents', 'label1BCents'] as const

export function zeroDeltas(): BasLabelDeltas {
  return { g1Cents: 0, g3Cents: 0, g4Cents: 0, g10Cents: 0, g11Cents: 0, label1ACents: 0, label1BCents: 0 }
}

export function addDeltas(a: BasLabelDeltas, b: BasLabelDeltas): BasLabelDeltas {
  const out = zeroDeltas()
  for (const k of LABEL_KEYS) out[k] = a[k] + b[k]
  return out
}

export function subtractDeltas(a: BasLabelDeltas, b: BasLabelDeltas): BasLabelDeltas {
  const out = zeroDeltas()
  for (const k of LABEL_KEYS) out[k] = a[k] - b[k]
  return out
}

export function isZeroDeltas(d: BasLabelDeltas): boolean {
  return LABEL_KEYS.every((k) => d[k] === 0)
}

/**
 * The label amounts a set of prior-period changes adds to this BAS. G labels take the
 * changes as they are. GST does not: the ATO has a correction made in a later BAS reported
 * at 1A when it increases the GST owed and at 1B when it decreases it, so each change's net
 * effect (Δ1A − Δ1B) lands whole on one side. A reversed credit (cage resold, purchase
 * refunded) therefore adds to 1A rather than making 1B negative.
 */
export function priorPeriodAdjustmentTotals(changes: BasLabelDeltas[]): BasLabelDeltas {
  const totals = zeroDeltas()
  for (const d of changes) {
    totals.g1Cents += d.g1Cents
    totals.g3Cents += d.g3Cents
    totals.g4Cents += d.g4Cents
    totals.g10Cents += d.g10Cents
    totals.g11Cents += d.g11Cents
    const net = d.label1ACents - d.label1BCents
    if (net > 0) totals.label1ACents += net
    else totals.label1BCents += -net
  }
  return totals
}
