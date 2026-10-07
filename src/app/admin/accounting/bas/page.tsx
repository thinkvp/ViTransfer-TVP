'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { apiFetch } from '@/lib/api-client'
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react'
import type { BasLabelDeltas, BasPeriod, BasPeriodStatus } from '@/lib/accounting/types'
import { AccountingTableActionButton } from '@/components/admin/accounting/AccountingTableActionButton'
import { ExportMenu, downloadCsv, generateReportPdf } from '@/components/admin/accounting/ExportMenu'
import { cn, formatDate } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'

type BasSortKey = 'label' | 'startDate' | 'quarter' | 'basis' | 'status' | 'lodgedAt' | 'settlement'

function fmtAud(cents: number) {
  return `$${(Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** ATO BAS amounts are whole dollars, rounded down (mirrors the detail page). */
function truncateBasCents(cents: number) {
  const wholeDollarsCents = Math.floor(Math.abs(cents) / 100) * 100
  return cents < 0 ? -wholeDollarsCents : wholeDollarsCents
}

type Settlement =
  | { kind: 'paid'; cents: number; date: string; reconciled: boolean }
  | { kind: 'received'; cents: number; date: string; reconciled: boolean }
  | { kind: 'unpaid'; cents: number }
  | { kind: 'refund'; cents: number }
  | { kind: 'nil' }

/**
 * What a lodged period settled for. A recorded payment/refund wins (paymentAmountCents
 * is signed, negative = refund received); otherwise fall back to label 9 from the
 * lodge-time snapshot (8A − 8B) as the amount still outstanding either way.
 */
function getSettlement(p: BasPeriod): Settlement | null {
  if (p.status !== 'LODGED') return null
  if (p.paymentDate && p.paymentAmountCents != null) {
    const reconciled = !!p.bankTransactionId
    return p.paymentAmountCents < 0
      ? { kind: 'received', cents: -p.paymentAmountCents, date: p.paymentDate, reconciled }
      : { kind: 'paid', cents: p.paymentAmountCents, date: p.paymentDate, reconciled }
  }
  const calc = p.calculationJson
  if (!calc) return null
  const label9 = truncateBasCents(calc.label1ACents)
    + truncateBasCents(p.paygWithholdingCents ?? 0)
    + truncateBasCents(p.paygInstalmentCents ?? 0)
    - truncateBasCents(calc.label1BCents)
  if (label9 > 0) return { kind: 'unpaid', cents: label9 }
  if (label9 < 0) return { kind: 'refund', cents: -label9 }
  return { kind: 'nil' }
}

/** Signed amount for sorting: payments positive, refunds negative, not-lodged lowest. */
function settlementSortValue(s: Settlement | null) {
  if (!s) return Number.NEGATIVE_INFINITY
  if (s.kind === 'refund' || s.kind === 'received') return -s.cents
  if (s.kind === 'nil') return 0
  return s.cents
}

function settlementExport(s: Settlement | null): [string, string] {
  if (!s) return ['', '']
  switch (s.kind) {
    case 'paid': return [(s.cents / 100).toFixed(2), `Paid ${s.date}`]
    case 'received': return [(-s.cents / 100).toFixed(2), `Refund received ${s.date}`]
    case 'unpaid': return [(s.cents / 100).toFixed(2), 'Unpaid']
    case 'refund': return [(-s.cents / 100).toFixed(2), 'Refund not yet received']
    case 'nil': return ['0.00', 'Nil']
  }
}

interface PeriodChanges {
  outstandingCount: number
  outstandingTotals: BasLabelDeltas
}

function changesTitle(c: PeriodChanges) {
  const net = c.outstandingTotals.label1ACents - c.outstandingTotals.label1BCents
  const effect = net === 0 ? 'no net GST change' : net > 0 ? `${fmtAud(net)} more GST payable` : `${fmtAud(-net)} less GST payable`
  return `${c.outstandingCount} change${c.outstandingCount === 1 ? '' : 's'} since lodgement not yet carried into a later BAS (${effect})`
}

const STATUS_BADGE: Record<BasPeriodStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  REVIEWED: 'bg-blue-500/15 text-blue-400',
  LODGED: 'bg-green-500/15 text-green-400',
}

const STATUS_LABELS: Record<BasPeriodStatus, string> = {
  DRAFT: 'Draft',
  REVIEWED: 'Reviewed',
  LODGED: 'Lodged',
}

export default function BasPage() {
  const router = useRouter()
  const [periods, setPeriods] = useState<BasPeriod[]>([])
  const [loading, setLoading] = useState(true)
  // Lodged periods whose figures have changed since lodgement (outstanding only)
  const [changes, setChanges] = useState<Map<string, PeriodChanges>>(new Map())

  const [deleting, setDeleting] = useState(false)
  const [pendingDeletePeriod, setPendingDeletePeriod] = useState<BasPeriod | null>(null)
  const [sortKey, setSortKey] = useState<BasSortKey>('startDate')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sortedPeriods = useMemo(() => {
    return [...periods].sort((a, b) => {
      let r = 0
      switch (sortKey) {
        case 'label': r = (a.label ?? `Q${a.quarter} ${a.financialYear}`).localeCompare(b.label ?? `Q${b.quarter} ${b.financialYear}`); break
        case 'startDate': r = a.startDate.localeCompare(b.startDate); break
        case 'quarter': r = (parseInt(a.financialYear) * 10 + a.quarter) - (parseInt(b.financialYear) * 10 + b.quarter); break
        case 'basis': r = a.basis.localeCompare(b.basis); break
        case 'status': r = a.status.localeCompare(b.status); break
        case 'lodgedAt': r = (a.lodgedAt ?? '').localeCompare(b.lodgedAt ?? ''); break
        case 'settlement': {
          const av = settlementSortValue(getSettlement(a)), bv = settlementSortValue(getSettlement(b))
          r = av === bv ? 0 : av < bv ? -1 : 1
          break
        }
      }
      return sortDir === 'asc' ? r : -r
    })
  }, [periods, sortKey, sortDir])

  function toggleSort(key: BasSortKey) {
    setSortKey(prev => {
      if (prev !== key) { setSortDir('asc'); return key }
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
      return prev
    })
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/admin/accounting/bas')
      if (res.ok) { const d = await res.json(); setPeriods(d.periods ?? []) }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  // Separate from load(): it recalculates every lodged period, so it can arrive later.
  useEffect(() => {
    let cancelled = false
    apiFetch('/api/admin/accounting/bas/changes')
      .then(r => r.ok ? r.json() : null)
      .then((d: { periods?: Array<PeriodChanges & { periodId: string }> } | null) => {
        if (cancelled || !d?.periods) return
        setChanges(new Map(d.periods.filter(p => p.outstandingCount > 0).map(p => [p.periodId, p])))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  async function handleDelete(target: BasPeriod) {
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${target.id}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Failed to delete'); return }
      await load()
    } finally { setDeleting(false) }
  }

  return (
    <>
      <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">BAS / GST</h2>
          <p className="text-sm text-muted-foreground">Calculate and lodge Business Activity Statements.</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu
            onExportCsv={() => {
              downloadCsv('bas-periods.csv', ['Label', 'Quarter', 'Start', 'End', 'Basis', 'Status', 'Lodged', 'Paid / Refunded', 'Settlement'], periods.map(p => [
                p.label, String(p.quarter), p.startDate, p.endDate, p.basis, STATUS_LABELS[p.status as BasPeriodStatus] ?? p.status, p.lodgedAt ? formatDate(p.lodgedAt) : '',
                ...settlementExport(getSettlement(p)),
              ]))
            }}
            onExportPdf={() => generateReportPdf({
              title: 'BAS Periods',
              sections: [{
                columns: [
                  { header: 'Label' },
                  { header: 'Quarter', nowrap: true },
                  { header: 'Start', nowrap: true },
                  { header: 'End', nowrap: true },
                  { header: 'Basis', nowrap: true },
                  { header: 'Status', nowrap: true },
                  { header: 'Lodged', nowrap: true },
                  { header: 'Paid / Refunded', nowrap: true },
                ],
                rows: periods.map(p => {
                  const [amount, note] = settlementExport(getSettlement(p))
                  return {
                    cells: [p.label, String(p.quarter), p.startDate, p.endDate, p.basis, STATUS_LABELS[p.status as BasPeriodStatus] ?? p.status, p.lodgedAt ? formatDate(p.lodgedAt) : '—', amount ? `${amount} (${note})` : '—'],
                  }
                }),
              }],
            })}
            disabled={periods.length === 0}
          />
          <Button onClick={() => router.push('/admin/accounting/bas/new')}>
            <Plus className="w-4 h-4 mr-1.5" />New BAS Period
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">Loading…</div>
          ) : periods.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">No BAS periods yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b border-border">
                    {([
                      { key: 'label', label: 'Period', className: 'min-w-[180px]' },
                      { key: 'startDate', label: 'Dates', className: 'min-w-[190px]' },
                      { key: 'quarter', label: 'Quarter', className: 'min-w-[120px]' },
                      { key: 'basis', label: 'Basis', className: 'min-w-[100px]' },
                      { key: 'status', label: 'Status', className: 'min-w-[120px]' },
                      { key: 'lodgedAt', label: 'Lodged', className: 'min-w-[120px]' },
                      { key: 'settlement', label: 'Paid / Refunded', className: 'min-w-[150px]' },
                    ] as { key: BasSortKey; label: string; className: string }[]).map(col => (
                      <th key={col.key} className={cn('px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap', col.className)}>
                        <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                          {col.label}
                          {sortKey === col.key ? (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : null}
                        </button>
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap min-w-[88px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPeriods.map(p => (
                    <tr
                      key={p.id}
                      className="border-b border-border last:border-b-0 hover:bg-muted/40 cursor-pointer"
                      onClick={() => router.push(`/admin/accounting/bas/${p.id}`)}
                    >
                      <td className="px-3 py-2 font-medium whitespace-nowrap min-w-[180px]">{p.label || `Q${p.quarter} ${p.financialYear}`}</td>
                      <td className="px-3 py-2 text-muted-foreground tabular-nums text-xs whitespace-nowrap min-w-[190px]">{formatDate(p.startDate)} → {formatDate(p.endDate)}</td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap min-w-[120px]">Q{p.quarter} FY{p.financialYear}</td>
                      <td className="px-3 py-2 text-muted-foreground capitalize whitespace-nowrap min-w-[100px]">{p.basis.toLowerCase()}</td>
                      <td className="px-3 py-2 whitespace-nowrap min-w-[120px]">
                        <span className={cn('inline-flex px-2 py-0.5 rounded text-xs font-medium', STATUS_BADGE[p.status])}>
                          {STATUS_LABELS[p.status]}
                        </span>
                        {changes.has(p.id) && (
                          <span
                            className="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-yellow-500/15 text-yellow-400"
                            title={changesTitle(changes.get(p.id)!)}
                          >
                            <AlertTriangle className="w-3 h-3" />Changed
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap min-w-[120px]">{p.lodgedAt ? p.lodgedAt.slice(0, 10) : '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap min-w-[150px]">
                        <SettlementCell settlement={getSettlement(p)} />
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap min-w-[88px]" onClick={ev => ev.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <AccountingTableActionButton onClick={() => router.push(`/admin/accounting/bas/${p.id}`)} title="Edit BAS period" aria-label="Edit BAS period">
                            <Pencil className="w-3.5 h-3.5" />
                          </AccountingTableActionButton>
                          {p.status !== 'LODGED' && (
                            <AccountingTableActionButton destructive onClick={() => setPendingDeletePeriod(p)} title="Delete BAS period" aria-label="Delete BAS period">
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </AccountingTableActionButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      </div>

      <ConfirmDialog
        open={pendingDeletePeriod !== null}
        onOpenChange={(v) => { if (!v) setPendingDeletePeriod(null) }}
        title={`Delete BAS Period "${pendingDeletePeriod?.label ?? ''}"?`}
        description="This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          const p = pendingDeletePeriod!
          setPendingDeletePeriod(null)
          void handleDelete(p)
        }}
      />
    </>
  )
}

function SettlementCell({ settlement: s }: { settlement: Settlement | null }) {
  if (!s) return <span className="text-muted-foreground">—</span>
  if (s.kind === 'nil') return <span className="text-muted-foreground text-xs">Nil</span>
  const note = s.kind === 'paid' ? `Paid ${s.date}${s.reconciled ? '' : ' · not reconciled'}`
    : s.kind === 'received' ? `Refund received ${s.date}${s.reconciled ? '' : ' · not reconciled'}`
    : s.kind === 'unpaid' ? 'Not yet paid'
    : 'Refund not yet received'
  const outstanding = s.kind === 'unpaid' || s.kind === 'refund'
  const isRefund = s.kind === 'refund' || s.kind === 'received'
  return (
    <div className="leading-tight">
      <span className={cn('tabular-nums font-medium', isRefund && 'text-green-400')}>{fmtAud(s.cents)}</span>
      <div className={cn('text-[11px]', outstanding ? 'text-yellow-400' : 'text-muted-foreground')}>{note}</div>
    </div>
  )
}
