'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { apiFetch } from '@/lib/api-client'
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import type { BasPeriod, BasPeriodStatus } from '@/lib/accounting/types'
import { ExportMenu, downloadCsv, downloadPdf } from '@/components/admin/accounting/ExportMenu'
import { cn, formatDate } from '@/lib/utils'

type BasSortKey = 'label' | 'startDate' | 'quarter' | 'basis' | 'status' | 'lodgedAt'

const STATUS_BADGE: Record<BasPeriodStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  REVIEWED: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  LODGED: 'bg-green-500/15 text-green-700 dark:text-green-400',
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
  const [deleteTarget, setDeleteTarget] = useState<BasPeriod | null>(null)
  const [deleting, setDeleting] = useState(false)
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

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${deleteTarget.id}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete'); return }
      setDeleteTarget(null)
      await load()
    } finally { setDeleting(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">BAS / GST</h2>
          <p className="text-sm text-muted-foreground">Calculate and lodge Business Activity Statements.</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu
            onExportCsv={() => {
              downloadCsv('bas-periods.csv', ['Label', 'Quarter', 'Start', 'End', 'Basis', 'Status', 'Lodged'], periods.map(p => [
                p.label, String(p.quarter), p.startDate, p.endDate, p.basis, STATUS_LABELS[p.status as BasPeriodStatus] ?? p.status, p.lodgedAt ? formatDate(p.lodgedAt) : '',
              ]))
            }}
            onExportPdf={() => downloadPdf('BAS Periods')}
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
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b border-border">
                    {([
                      { key: 'label', label: 'Period' },
                      { key: 'startDate', label: 'Dates' },
                      { key: 'quarter', label: 'Quarter' },
                      { key: 'basis', label: 'Basis' },
                      { key: 'status', label: 'Status' },
                      { key: 'lodgedAt', label: 'Lodged' },
                    ] as { key: BasSortKey; label: string }[]).map(col => (
                      <th key={col.key} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                        <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                          {col.label}
                          {sortKey === col.key ? (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : null}
                        </button>
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPeriods.map(p => (
                    <tr
                      key={p.id}
                      className="border-b border-border last:border-b-0 hover:bg-muted/40 cursor-pointer"
                      onClick={() => router.push(`/admin/accounting/bas/${p.id}`)}
                    >
                      <td className="px-3 py-2 font-medium">{p.label || `Q${p.quarter} ${p.financialYear}`}</td>
                      <td className="px-3 py-2 text-muted-foreground tabular-nums text-xs">{formatDate(p.startDate)} → {formatDate(p.endDate)}</td>
                      <td className="px-3 py-2 text-muted-foreground">Q{p.quarter} FY{p.financialYear}</td>
                      <td className="px-3 py-2 text-muted-foreground capitalize">{p.basis.toLowerCase()}</td>
                      <td className="px-3 py-2">
                        <span className={cn('inline-flex px-2 py-0.5 rounded text-xs font-medium', STATUS_BADGE[p.status])}>
                          {STATUS_LABELS[p.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground text-xs">{p.lodgedAt ? p.lodgedAt.slice(0, 10) : '—'}</td>
                      <td className="px-3 py-2 text-right" onClick={ev => ev.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push(`/admin/accounting/bas/${p.id}`)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {p.status !== 'LODGED' && (
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDeleteTarget(p)}>
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </Button>
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

      <AlertDialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete BAS period?</AlertDialogTitle>
            <AlertDialogDescription>Delete <strong>{deleteTarget?.label}</strong>? This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
