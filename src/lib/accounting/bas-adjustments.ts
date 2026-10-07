/**
 * Changes to lodged BAS periods, and carrying them into a later BAS.
 *
 * A lodged period keeps a snapshot of the source records it reported (recordsJson). Its
 * "drift" is the live recalculation of the same date range minus that snapshot, compared
 * per source record (or per invoice, for cash-basis receipts). Each change can then be
 * resolved, recorded as a BasAdjustment row:
 *   CARRIED — included as a prior-period adjustment in a later BAS (written at that lodge)
 *   AMENDED — the user revised the original BAS with the ATO instead
 * so what is still outstanding = live − snapshot − Σ resolved rows. Nothing about the change
 * itself is stored, which means editing a record back to its lodged value, or editing it
 * again after it was carried, shows up as a further change of its own.
 *
 * An un-lodged period offers every outstanding change from periods that ended before it
 * starts; the user can leave individual changes out (BasPeriod.excludedAdjustmentKeys).
 */

import { prisma } from '@/lib/db'
import { calculateBas, type BasCalculation, type BasCalculationResult, type BasIssue } from '@/lib/accounting/gst'
import {
  addDeltas,
  isZeroDeltas,
  priorPeriodAdjustmentTotals,
  subtractDeltas,
  zeroDeltas,
} from '@/lib/accounting/bas-adjustment-totals'
import type {
  BasAdjustmentRow,
  BasExpenseRecord,
  BasLabelDeltas,
  BasPeriodDrift,
  BasPriorPeriodItem,
  BasRecordChange,
  BasSalesRecord,
} from '@/lib/accounting/types'

/** What a sales record adds to each label — mirrors calculateBas's sales totals. */
function salesContribution(r: BasSalesRecord): BasLabelDeltas {
  const code = r.taxCode ?? (r.taxEnabled ? 'GST' : 'GST_FREE')
  return {
    ...zeroDeltas(),
    g1Cents: r.totalIncGstCents,
    g3Cents: code === 'GST_FREE' ? r.totalIncGstCents : 0,
    g4Cents: code === 'INPUT_TAXED' ? r.totalIncGstCents : 0,
    label1ACents: r.gstCents,
  }
}

/** What a purchase record adds to each label — mirrors calculateBas's purchase loop. */
function purchaseContribution(r: BasExpenseRecord): BasLabelDeltas {
  if (r.taxCode === 'BAS_EXCLUDED') return zeroDeltas()
  return {
    ...zeroDeltas(),
    g10Cents: r.isCapital ? r.amountIncGstCents : 0,
    g11Cents: r.isCapital ? 0 : r.amountIncGstCents,
    label1BCents: r.taxCode === 'GST' ? r.gstCents : 0,
  }
}

// ── Grouping records by stable key ──────────────────────────────────────────

interface RecordGroup {
  recordKey: string
  side: 'SALES' | 'PURCHASES'
  date: string
  description: string
  amountIncGstCents: number
  gstCents: number
  contribution: BasLabelDeltas
}

/**
 * Invoice and cash-receipt rows have no `kind` and are keyed by invoice — on cash basis
 * every receipt against one invoice folds into that invoice's group, which is fine for
 * comparing totals. Everything else is keyed by its own record id.
 */
function salesKey(r: BasSalesRecord): string {
  return r.kind ? `S|${r.kind}:${r.id}` : `S|invoice:${r.id}`
}

function purchaseKey(r: BasExpenseRecord): string {
  return `P|${r.kind ?? 'expense'}:${r.id}`
}

function salesDescription(r: BasSalesRecord): string {
  if (r.kind) return r.clientName || 'Income posting'
  if (r.invoiceNumber && r.invoiceNumber !== '—') return `Invoice ${r.invoiceNumber} — ${r.clientName}`
  return `Payment without an invoice — ${r.clientName}`
}

function purchaseDescription(r: BasExpenseRecord): string {
  return r.supplier ? `${r.supplier} — ${r.description}` : r.description
}

function groupRecords(
  records: { sales: BasSalesRecord[]; expenses: BasExpenseRecord[] },
  keyFor: { sales: (r: BasSalesRecord) => string; expenses: (r: BasExpenseRecord) => string }
): Map<string, RecordGroup> {
  const groups = new Map<string, RecordGroup>()
  const add = (key: string, side: RecordGroup['side'], date: string, description: string, amount: number, gst: number, contribution: BasLabelDeltas) => {
    const g = groups.get(key)
    if (g) {
      g.amountIncGstCents += amount
      g.gstCents += gst
      g.contribution = addDeltas(g.contribution, contribution)
      if (date > g.date) g.date = date
    } else {
      groups.set(key, { recordKey: key, side, date, description, amountIncGstCents: amount, gstCents: gst, contribution })
    }
  }
  for (const r of records.sales ?? []) {
    add(keyFor.sales(r), 'SALES', r.date, salesDescription(r), r.totalIncGstCents, r.gstCents, salesContribution(r))
  }
  for (const r of records.expenses ?? []) {
    add(keyFor.expenses(r), 'PURCHASES', r.date, purchaseDescription(r), r.amountIncGstCents, r.gstCents, purchaseContribution(r))
  }
  return groups
}

/**
 * Snapshots taken before a field existed can lack `kind` (purchases, income postings) or
 * `taxCode` (sales). Fill them from the matching live record so an old snapshot does not
 * show every row as removed-and-re-added.
 */
function normaliseLegacySnapshot(
  snapshot: { sales: BasSalesRecord[]; expenses: BasExpenseRecord[] },
  live: { sales: BasSalesRecord[]; expenses: BasExpenseRecord[] }
) {
  const liveSalesById = new Map(live.sales.filter((r) => r.kind).map((r) => [r.id, r]))
  const liveSalesByKey = new Map(live.sales.map((r) => [salesKey(r), r]))
  const livePurchasesById = new Map(live.expenses.map((r) => [r.id, r]))

  const sales = (snapshot.sales ?? []).map((r) => {
    let out = r
    if (!out.kind) {
      const posting = liveSalesById.get(out.id)
      if (posting) out = { ...out, kind: posting.kind, bankTransactionId: posting.bankTransactionId }
    }
    if (!out.taxCode) {
      const match = liveSalesByKey.get(salesKey(out))
      if (match?.taxCode && match.taxEnabled === out.taxEnabled) out = { ...out, taxCode: match.taxCode }
    }
    return out
  })
  const expenses = (snapshot.expenses ?? []).map((r) => {
    if (r.kind) return r
    const match = livePurchasesById.get(r.id)
    return match ? { ...r, kind: match.kind } : r
  })
  return { sales, expenses }
}

// ── Drift for lodged periods ────────────────────────────────────────────────

type LodgedPeriodRow = {
  id: string
  label: string
  quarter: number
  financialYear: string
  startDate: string
  endDate: string
  basis: string
  g2Override: number | null
  g3Override: number | null
  recordsJson: unknown
  adjustmentsFrom: Array<{
    id: string
    sourcePeriodId: string
    targetPeriodId: string | null
    resolution: 'CARRIED' | 'AMENDED'
    recordKey: string
    description: string
    recordDate: string
    g1Cents: number
    g3Cents: number
    g4Cents: number
    g10Cents: number
    g11Cents: number
    label1ACents: number
    label1BCents: number
    createdByName: string | null
    createdAt: Date
    targetPeriod: { label: string; quarter: number; financialYear: string } | null
  }>
}

export function basPeriodLabel(p: { label: string | null; quarter: number; financialYear: string }): string {
  return p.label || `Q${p.quarter} ${p.financialYear}`
}

function adjustmentDeltas(a: LodgedPeriodRow['adjustmentsFrom'][number]): BasLabelDeltas {
  return {
    g1Cents: a.g1Cents,
    g3Cents: a.g3Cents,
    g4Cents: a.g4Cents,
    g10Cents: a.g10Cents,
    g11Cents: a.g11Cents,
    label1ACents: a.label1ACents,
    label1BCents: a.label1BCents,
  }
}

const lodgedPeriodSelect = {
  id: true,
  label: true,
  quarter: true,
  financialYear: true,
  startDate: true,
  endDate: true,
  basis: true,
  g2Override: true,
  g3Override: true,
  recordsJson: true,
  adjustmentsFrom: {
    orderBy: { createdAt: 'asc' as const },
    include: { targetPeriod: { select: { label: true, quarter: true, financialYear: true } } },
  },
} as const

async function driftForPeriod(p: LodgedPeriodRow): Promise<BasPeriodDrift> {
  const periodLabel = basPeriodLabel(p)
  const adjustments: BasAdjustmentRow[] = p.adjustmentsFrom.map((a) => ({
    id: a.id,
    sourcePeriodId: a.sourcePeriodId,
    sourcePeriodLabel: periodLabel,
    targetPeriodId: a.targetPeriodId,
    targetPeriodLabel: a.targetPeriod ? basPeriodLabel(a.targetPeriod) : null,
    resolution: a.resolution,
    recordKey: a.recordKey,
    description: a.description,
    recordDate: a.recordDate,
    deltas: adjustmentDeltas(a),
    createdByName: a.createdByName,
    createdAt: a.createdAt.toISOString(),
  }))

  const snapshotRaw = p.recordsJson as { sales?: BasSalesRecord[]; expenses?: BasExpenseRecord[] } | null
  if (!snapshotRaw || !Array.isArray(snapshotRaw.sales) || !Array.isArray(snapshotRaw.expenses)) {
    return {
      periodId: p.id, periodLabel, startDate: p.startDate, endDate: p.endDate,
      comparable: false, changes: [], outstandingTotals: zeroDeltas(), outstandingCount: 0, adjustments,
    }
  }

  const live = await calculateBas(p.startDate, p.endDate, p.basis === 'ACCRUAL' ? 'ACCRUAL' : 'CASH', p.g2Override, p.g3Override)
  const snapshot = normaliseLegacySnapshot({ sales: snapshotRaw.sales, expenses: snapshotRaw.expenses }, live.records)
  const keyFor = { sales: salesKey, expenses: purchaseKey }
  const before = groupRecords(snapshot, keyFor)
  const after = groupRecords(live.records, keyFor)

  const resolvedByKey = new Map<string, BasLabelDeltas>()
  const adjustmentByKey = new Map<string, BasAdjustmentRow>()
  for (const a of adjustments) {
    resolvedByKey.set(a.recordKey, addDeltas(resolvedByKey.get(a.recordKey) ?? zeroDeltas(), a.deltas))
    adjustmentByKey.set(a.recordKey, a)
  }

  const keys = new Set<string>([...before.keys(), ...after.keys(), ...resolvedByKey.keys()])
  const changes: BasRecordChange[] = []
  let outstandingTotals = zeroDeltas()
  let outstandingCount = 0

  for (const recordKey of keys) {
    const b = before.get(recordKey) ?? null
    const a = after.get(recordKey) ?? null
    const deltas = subtractDeltas(a?.contribution ?? zeroDeltas(), b?.contribution ?? zeroDeltas())
    const resolvedDeltas = resolvedByKey.get(recordKey) ?? zeroDeltas()
    if (isZeroDeltas(deltas) && isZeroDeltas(resolvedDeltas)) continue

    const outstandingDeltas = subtractDeltas(deltas, resolvedDeltas)
    const outstanding = !isZeroDeltas(outstandingDeltas)
    const fallback = adjustmentByKey.get(recordKey)
    const change: BasRecordChange['change'] = isZeroDeltas(deltas) ? 'REVERTED' : !b ? 'ADDED' : !a ? 'REMOVED' : 'CHANGED'

    changes.push({
      key: `${p.id}|${recordKey}`,
      sourcePeriodId: p.id,
      recordKey,
      side: (a ?? b)?.side ?? (recordKey.startsWith('S|') ? 'SALES' : 'PURCHASES'),
      change,
      date: (a ?? b)?.date ?? fallback?.recordDate ?? p.endDate,
      description: (a ?? b)?.description ?? fallback?.description ?? recordKey,
      before: b ? { amountIncGstCents: b.amountIncGstCents, gstCents: b.gstCents } : null,
      after: a ? { amountIncGstCents: a.amountIncGstCents, gstCents: a.gstCents } : null,
      deltas,
      resolvedDeltas,
      outstandingDeltas,
      outstanding,
    })
    if (outstanding) {
      outstandingTotals = addDeltas(outstandingTotals, outstandingDeltas)
      outstandingCount++
    }
  }

  changes.sort((x, y) => x.date.localeCompare(y.date) || x.description.localeCompare(y.description))

  return {
    periodId: p.id, periodLabel, startDate: p.startDate, endDate: p.endDate,
    comparable: true, changes, outstandingTotals, outstandingCount, adjustments,
  }
}

/** Changes since lodgement for the given lodged periods (all lodged periods when omitted). */
export async function getLodgedPeriodDrift(where?: { ids?: string[]; endBefore?: string }): Promise<BasPeriodDrift[]> {
  const periods = await prisma.basPeriod.findMany({
    where: {
      status: 'LODGED',
      ...(where?.ids ? { id: { in: where.ids } } : {}),
      ...(where?.endBefore ? { endDate: { lt: where.endBefore } } : {}),
    },
    select: lodgedPeriodSelect,
    orderBy: { startDate: 'asc' },
  })
  // Sequential: each is a full BAS calculation, and there are only ever a handful.
  const out: BasPeriodDrift[] = []
  for (const p of periods) out.push(await driftForPeriod(p as unknown as LodgedPeriodRow))
  return out
}

// ── Un-lodged periods: prior-period adjustments ─────────────────────────────

type OpenPeriod = {
  id: string
  status: string
  startDate: string
  endDate: string
  basis: string
  g2Override: number | null
  g3Override: number | null
  excludedAdjustmentKeys: unknown
}

function excludedKeySet(raw: unknown): Set<string> {
  return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [])
}

/** Outstanding changes from lodged periods that ended before this period starts. */
export async function getPriorPeriodItems(period: OpenPeriod): Promise<BasPriorPeriodItem[]> {
  if (period.status === 'LODGED') return []
  const excluded = excludedKeySet(period.excludedAdjustmentKeys)
  const drifts = await getLodgedPeriodDrift({ endBefore: period.startDate })
  const items: BasPriorPeriodItem[] = []
  for (const d of drifts) {
    for (const c of d.changes) {
      if (!c.outstanding) continue
      items.push({ ...c, sourcePeriodLabel: d.periodLabel, included: !excluded.has(c.key) })
    }
  }
  return items
}

/** Add prior-period adjustment totals (from priorPeriodAdjustmentTotals) onto a calculated BAS. */
export function applyPriorPeriodAdjustments(
  calc: BasCalculation,
  totals: BasLabelDeltas,
  g3Override: number | null
): BasCalculation {
  if (isZeroDeltas(totals)) return { ...calc, priorPeriodAdjustments: null }
  const label1ACents = calc.label1ACents + totals.label1ACents
  const label1BCents = calc.label1BCents + totals.label1BCents
  return {
    ...calc,
    g1TotalSalesCents: calc.g1TotalSalesCents + totals.g1Cents,
    // An explicit G3 override is the final figure; otherwise adjust the computed one.
    g3OtherGstFreeCents: g3Override != null ? calc.g3OtherGstFreeCents : calc.g3OtherGstFreeCents + totals.g3Cents,
    g4InputTaxedSalesCents: calc.g4InputTaxedSalesCents + totals.g4Cents,
    g10CapitalPurchasesCents: calc.g10CapitalPurchasesCents + totals.g10Cents,
    g11NonCapitalPurchasesCents: calc.g11NonCapitalPurchasesCents + totals.g11Cents,
    label1ACents,
    label1BCents,
    netGstCents: label1ACents - label1BCents,
    totalIncomeCents: calc.totalIncomeCents + totals.g1Cents,
    priorPeriodAdjustments: totals,
  }
}

export interface BasPeriodCalculationResult extends BasCalculationResult {
  priorPeriodItems: BasPriorPeriodItem[]
}

/**
 * The BAS for a period as it would be lodged: this period's own records plus the
 * included prior-period adjustments. `records` stays this period's own records only.
 */
export async function calculateBasForPeriod(period: OpenPeriod): Promise<BasPeriodCalculationResult> {
  const basis = period.basis === 'ACCRUAL' ? 'ACCRUAL' : 'CASH'
  const base = await calculateBas(period.startDate, period.endDate, basis, period.g2Override, period.g3Override)
  const priorPeriodItems = await getPriorPeriodItems(period)

  const included = priorPeriodItems.filter((i) => i.included)
  const totals = priorPeriodAdjustmentTotals(included.map((i) => i.outstandingDeltas))
  const calculation = applyPriorPeriodAdjustments(base.calculation, totals, period.g3Override)

  const issues: BasIssue[] = [...base.issues]
  if (included.length > 0) {
    issues.push({
      severity: 'info',
      code: 'PRIOR_PERIOD_ADJUSTMENTS',
      message: `${included.length} change${included.length === 1 ? '' : 's'} to earlier lodged BAS periods ${included.length === 1 ? 'is' : 'are'} included as prior-period adjustments.`,
      count: included.length,
    })
  }
  const left = priorPeriodItems.length - included.length
  if (left > 0) {
    issues.push({
      severity: 'warning',
      code: 'PRIOR_PERIOD_ADJUSTMENTS_EXCLUDED',
      message: `${left} change${left === 1 ? '' : 's'} to earlier lodged BAS periods ${left === 1 ? 'is' : 'are'} left out of this BAS and will stay outstanding.`,
      count: left,
    })
  }

  return { calculation, issues, records: base.records, priorPeriodItems }
}
