'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { apiFetch } from '@/lib/api-client'
import { cn, formatDate } from '@/lib/utils'
import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { priorPeriodAdjustmentTotals } from '@/lib/accounting/bas-adjustment-totals'
import type { BasAdjustmentRow, BasLabelDeltas, BasPeriodDrift, BasPriorPeriodItem, BasRecordChange } from '@/lib/accounting/types'

function fmtAud(cents: number) {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `-$${abs}` : `$${abs}`
}

function fmtDelta(cents: number) {
  if (cents === 0) return '—'
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `−$${abs}` : `+$${abs}`
}

/** Effect on the amount payable: more GST collected or fewer credits = more to pay. */
function netGstEffect(d: BasLabelDeltas) {
  return d.label1ACents - d.label1BCents
}

const CHANGE_LABEL: Record<BasRecordChange['change'], string> = {
  ADDED: 'Added',
  REMOVED: 'Removed',
  CHANGED: 'Changed',
  REVERTED: 'Changed back',
}

function amountCell(v: { amountIncGstCents: number; gstCents: number } | null) {
  if (!v) return '—'
  return (
    <>
      {fmtAud(v.amountIncGstCents)}
      <div className="text-[10px] text-muted-foreground">GST {fmtAud(v.gstCents)}</div>
    </>
  )
}

function NetEffect({ deltas }: { deltas: BasLabelDeltas }) {
  const net = netGstEffect(deltas)
  if (net === 0) return <span className="text-muted-foreground">No GST change</span>
  return (
    <span className={cn('font-medium tabular-nums', net > 0 ? 'text-red-400' : 'text-green-400')}>
      {net > 0 ? `${fmtAud(net)} more GST payable` : `${fmtAud(-net)} less GST payable`}
    </span>
  )
}

interface ChangeTableProps {
  rows: Array<BasRecordChange & { sourcePeriodLabel?: string }>
  /** Deltas to show per row: the outstanding part, or the full change */
  useOutstanding: boolean
  selectable?: {
    isSelected: (key: string) => boolean
    onToggle: (key: string, selected: boolean) => void
    disabled?: boolean
  }
  showSourcePeriod?: boolean
  statusCell?: (row: BasRecordChange) => React.ReactNode
}

function ChangeTable({ rows, useOutstanding, selectable, showSourcePeriod, statusCell }: ChangeTableProps) {
  return (
    <div className="border border-border rounded-md overflow-x-auto">
      <table className="w-full text-xs min-w-[720px]">
        <thead>
          <tr className="bg-muted/40 border-b border-border">
            {selectable && <th className="px-2 py-1.5 w-8"></th>}
            <th className="text-left px-2 py-1.5 font-medium">Date</th>
            {showSourcePeriod && <th className="text-left px-2 py-1.5 font-medium">From</th>}
            <th className="text-left px-2 py-1.5 font-medium">Record</th>
            <th className="text-left px-2 py-1.5 font-medium">Change</th>
            <th className="text-right px-2 py-1.5 font-medium">Lodged</th>
            <th className="text-right px-2 py-1.5 font-medium">Now</th>
            <th className="text-right px-2 py-1.5 font-medium">G1</th>
            <th className="text-right px-2 py-1.5 font-medium">1A</th>
            <th className="text-right px-2 py-1.5 font-medium">1B</th>
            {statusCell && <th className="text-left px-2 py-1.5 font-medium">Status</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = useOutstanding ? r.outstandingDeltas : r.deltas
            return (
              <tr key={r.key} className="border-b border-border last:border-0">
                {selectable && (
                  <td className="px-2 py-1.5">
                    <Checkbox
                      checked={selectable.isSelected(r.key)}
                      disabled={selectable.disabled}
                      onCheckedChange={(v) => selectable.onToggle(r.key, v)}
                      aria-label="Include this change"
                    />
                  </td>
                )}
                <td className="px-2 py-1.5 whitespace-nowrap">{formatDate(r.date)}</td>
                {showSourcePeriod && <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{r.sourcePeriodLabel}</td>}
                <td className="px-2 py-1.5 max-w-[260px] truncate" title={r.description}>
                  <span className="text-muted-foreground mr-1">{r.side === 'SALES' ? 'Sale' : 'Purchase'} ·</span>{r.description}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">{CHANGE_LABEL[r.change]}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{amountCell(r.before)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{amountCell(r.after)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtDelta(d.g1Cents)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtDelta(d.label1ACents)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtDelta(d.label1BCents)}</td>
                {statusCell && <td className="px-2 py-1.5 whitespace-nowrap">{statusCell(r)}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function sumDeltas(rows: BasRecordChange[], pick: (r: BasRecordChange) => BasLabelDeltas): BasLabelDeltas {
  return rows.reduce<BasLabelDeltas>((acc, r) => {
    const d = pick(r)
    return {
      g1Cents: acc.g1Cents + d.g1Cents,
      g3Cents: acc.g3Cents + d.g3Cents,
      g4Cents: acc.g4Cents + d.g4Cents,
      g10Cents: acc.g10Cents + d.g10Cents,
      g11Cents: acc.g11Cents + d.g11Cents,
      label1ACents: acc.label1ACents + d.label1ACents,
      label1BCents: acc.label1BCents + d.label1BCents,
    }
  }, { g1Cents: 0, g3Cents: 0, g4Cents: 0, g10Cents: 0, g11Cents: 0, label1ACents: 0, label1BCents: 0 })
}

// ── Lodged period: changes since lodgement ──────────────────────────────────

interface CarriedIn {
  id: string
  sourcePeriodLabel: string
  description: string
  recordDate: string
  deltas: BasLabelDeltas
}

export function LodgedChangesCard({ periodId }: { periodId: string }) {
  const [loading, setLoading] = useState(true)
  const [drift, setDrift] = useState<BasPeriodDrift | null>(null)
  const [carriedIn, setCarriedIn] = useState<CarriedIn[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Count frozen when the dialog opens: the reload after amending clears the selection
  // while the dialog is still animating closed.
  const [amendConfirm, setAmendConfirm] = useState(false)
  const [amendCount, setAmendCount] = useState(0)
  const [undoTarget, setUndoTarget] = useState<BasAdjustmentRow | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${periodId}/changes`)
      if (!res.ok) return
      const d = await res.json()
      setDrift(d.drift ?? null)
      setCarriedIn(d.carriedIn ?? [])
      setSelected(new Set())
    } finally { setLoading(false) }
  }, [periodId])

  useEffect(() => { void load() }, [load])

  const adjustmentsByKey = useMemo(() => {
    const map = new Map<string, BasAdjustmentRow[]>()
    for (const a of drift?.adjustments ?? []) {
      const list = map.get(a.recordKey) ?? []
      list.push(a)
      map.set(a.recordKey, list)
    }
    return map
  }, [drift])

  async function handleAmend() {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${periodId}/adjustments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: Array.from(selected) }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Failed to mark as amended'); return }
      toast.success('Marked as amended')
      await load()
    } finally { setBusy(false) }
  }

  async function handleUndo(a: BasAdjustmentRow) {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${periodId}/adjustments?adjustmentId=${encodeURIComponent(a.id)}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Failed to undo'); return }
      await load()
    } finally { setBusy(false) }
  }

  if (loading && !drift) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />Checking for changes since lodgement…
        </CardContent>
      </Card>
    )
  }
  if (!drift) return null

  const outstandingRows = drift.changes.filter((c) => c.outstanding)

  return (
    <>
      <Card className={cn(drift.outstandingCount > 0 && 'border-yellow-500/40')}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            {drift.outstandingCount > 0
              ? <><AlertTriangle className="w-4 h-4 text-yellow-400" />Changed since lodgement</>
              : <><CheckCircle className="w-4 h-4 text-green-400" />Changes since lodgement</>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!drift.comparable ? (
            <p className="text-muted-foreground text-xs">
              This BAS was lodged before source records were saved with it, so later changes can&apos;t be tracked.
            </p>
          ) : drift.changes.length === 0 ? (
            <p className="text-muted-foreground text-xs">Nothing reported on this BAS has changed since it was lodged.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                These records were added, changed or removed after this BAS was lodged. Outstanding changes are offered
                as prior-period adjustments on your next un-lodged BAS. If you revised this BAS with the ATO instead,
                mark them as amended so they aren&apos;t reported twice.
              </p>
              {drift.outstandingCount > 0 && (
                <p className="text-xs">
                  <span className="font-medium">{drift.outstandingCount} outstanding:</span>{' '}
                  <NetEffect deltas={drift.outstandingTotals} />
                </p>
              )}
              <ChangeTable
                rows={drift.changes}
                useOutstanding={false}
                selectable={outstandingRows.length > 0 ? {
                  isSelected: (key) => selected.has(key),
                  onToggle: (key, v) => setSelected((prev) => {
                    const next = new Set(prev)
                    if (v) next.add(key); else next.delete(key)
                    return next
                  }),
                  disabled: busy,
                } : undefined}
                statusCell={(row) => {
                  const resolved = adjustmentsByKey.get(row.recordKey) ?? []
                  return (
                    <div className="flex flex-col gap-0.5">
                      {row.outstanding && <span className="text-yellow-400">Outstanding</span>}
                      {resolved.map((a) => (
                        <span key={a.id} className="text-muted-foreground">
                          {a.resolution === 'CARRIED' ? `Carried to ${a.targetPeriodLabel ?? 'a later BAS'}` : 'Amended with ATO'}
                          {a.resolution === 'AMENDED' && (
                            <button
                              type="button"
                              className="ml-1.5 underline hover:text-foreground disabled:opacity-50"
                              disabled={busy}
                              onClick={() => setUndoTarget(a)}
                            >
                              Undo
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )
                }}
              />
              {outstandingRows.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSelected(new Set(outstandingRows.map((r) => r.key)))}
                    disabled={busy}
                  >
                    Select all outstanding
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setAmendCount(selected.size); setAmendConfirm(true) }} disabled={busy || selected.size === 0}>
                    {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                    Mark as amended with ATO{selected.size > 0 ? ` (${selected.size})` : ''}
                  </Button>
                </div>
              )}
            </>
          )}

          {carriedIn.length > 0 && (
            <div className="pt-2 space-y-1.5">
              <p className="text-xs font-medium">Prior-period adjustments included in this BAS</p>
              <div className="border border-border rounded-md overflow-x-auto">
                <table className="w-full text-xs min-w-[560px]">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border">
                      <th className="text-left px-2 py-1.5 font-medium">Date</th>
                      <th className="text-left px-2 py-1.5 font-medium">From</th>
                      <th className="text-left px-2 py-1.5 font-medium">Record</th>
                      <th className="text-right px-2 py-1.5 font-medium">G1</th>
                      <th className="text-right px-2 py-1.5 font-medium">1A</th>
                      <th className="text-right px-2 py-1.5 font-medium">1B</th>
                    </tr>
                  </thead>
                  <tbody>
                    {carriedIn.map((a) => (
                      <tr key={a.id} className="border-b border-border last:border-0">
                        <td className="px-2 py-1.5 whitespace-nowrap">{formatDate(a.recordDate)}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{a.sourcePeriodLabel}</td>
                        <td className="px-2 py-1.5 max-w-[260px] truncate" title={a.description}>{a.description}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtDelta(a.deltas.g1Cents)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtDelta(a.deltas.label1ACents)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtDelta(a.deltas.label1BCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={amendConfirm}
        onOpenChange={setAmendConfirm}
        title="Mark as amended with the ATO?"
        description={amendCount === 1
          ? 'Use this only if you revised this BAS with the ATO to include this change. It will no longer be offered as a prior-period adjustment.'
          : `Use this only if you revised this BAS with the ATO to include these ${amendCount} changes. They will no longer be offered as prior-period adjustments.`}
        confirmLabel="Mark as amended"
        variant="default"
        onConfirm={handleAmend}
      />
      <ConfirmDialog
        open={undoTarget !== null}
        onOpenChange={(v) => { if (!v) setUndoTarget(null) }}
        title="Undo amended?"
        description="The change becomes outstanding again and will be offered on your next un-lodged BAS."
        confirmLabel="Undo"
        variant="default"
        onConfirm={async () => { if (undoTarget) await handleUndo(undoTarget) }}
      />
    </>
  )
}

// ── Un-lodged period: prior-period adjustments to include ───────────────────

export function PriorPeriodAdjustmentsCard({
  items,
  saving,
  onToggle,
}: {
  items: BasPriorPeriodItem[]
  saving: boolean
  onToggle: (key: string, include: boolean) => void
}) {
  if (items.length === 0) return null
  const included = items.filter((i) => i.included)
  const totals = sumDeltas(included, (r) => r.outstandingDeltas)
  const routed = priorPeriodAdjustmentTotals(included.map((i) => i.outstandingDeltas))

  return (
    <Card className="border-yellow-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-yellow-400" />Prior-period adjustments
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          These records in earlier, already-lodged BAS periods were added, changed or removed after lodgement. Ticked
          changes are added to this BAS&apos;s figures and recorded as carried when you lodge it. Untick any you&apos;ve
          dealt with another way. They stay outstanding for a later BAS.
        </p>
        <p className="text-xs text-muted-foreground">
          As the ATO asks for corrections, each change&apos;s GST goes to 1A if it increases the GST you owe and to 1B
          if it decreases it. The G1, 1A and 1B columns below show the change itself.
        </p>
        <ChangeTable
          rows={items}
          useOutstanding
          showSourcePeriod
          selectable={{
            isSelected: (key) => items.find((i) => i.key === key)?.included ?? false,
            onToggle,
            disabled: saving,
          }}
        />
        <p className="text-xs">
          <span className="font-medium">Included ({included.length} of {items.length}):</span>{' '}
          Adds G1 {fmtDelta(routed.g1Cents)} · 1A {fmtDelta(routed.label1ACents)} · 1B {fmtDelta(routed.label1BCents)} ·{' '}
          <NetEffect deltas={totals} />
        </p>
      </CardContent>
    </Card>
  )
}
