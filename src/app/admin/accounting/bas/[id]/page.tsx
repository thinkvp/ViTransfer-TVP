'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { apiFetch } from '@/lib/api-client'
import { ArrowLeft, Calculator, CheckCircle, FileCheck } from 'lucide-react'
import type { BasPeriod, BasCalculation, BasIssue, BasPeriodStatus } from '@/lib/accounting/types'
import { ExportMenu, downloadCsv, downloadPdf } from '@/components/admin/accounting/ExportMenu'
import { cn } from '@/lib/utils'

function fmtAud(cents: number) {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `-$${abs}` : `$${abs}`
}

const STATUS_BADGE: Record<BasPeriodStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  REVIEWED: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  LODGED: 'bg-green-500/15 text-green-700 dark:text-green-400',
}

export default function BasDetailPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = params?.id ?? ''

  const [period, setPeriod] = useState<BasPeriod | null>(null)
  const [loading, setLoading] = useState(true)
  const [calculation, setCalculation] = useState<BasCalculation | null>(null)
  const [issues, setIssues] = useState<BasIssue[]>([])
  const [calculating, setCalculating] = useState(false)

  const [g2Override, setG2Override] = useState('')
  const [g3Override, setG3Override] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [lodgeConfirm, setLodgeConfirm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${id}`)
      if (res.ok) {
        const d = await res.json()
        const p: BasPeriod = d.period
        setPeriod(p)
        setG2Override(p.g2Override != null ? (p.g2Override / 100).toFixed(2) : '')
        setG3Override(p.g3Override != null ? (p.g3Override / 100).toFixed(2) : '')
        setNotes(p.notes ?? '')
      }
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { void load() }, [load])

  async function handleCalculate() {
    setCalculating(true)
    try {
      const body: Record<string, unknown> = {}
      if (g2Override) body.g2Override = Math.round(parseFloat(g2Override) * 100)
      if (g3Override) body.g3Override = Math.round(parseFloat(g3Override) * 100)
      const res = await apiFetch(`/api/admin/accounting/bas/${id}/calculate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (res.ok) {
        const d = await res.json()
        setCalculation(d.calculation)
        setIssues(d.issues ?? [])
      }
    } finally { setCalculating(false) }
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const body: Record<string, unknown> = { notes: notes.trim() || null }
      if (g2Override) body.g2Override = Math.round(parseFloat(g2Override) * 100)
      if (g3Override) body.g3Override = Math.round(parseFloat(g3Override) * 100)
      const res = await apiFetch(`/api/admin/accounting/bas/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Save failed'); return }
      await load()
    } finally { setSaving(false) }
  }

  async function handleStatusChange(status: BasPeriodStatus) {
    setSaving(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed'); return }
      await load()
    } finally { setSaving(false) }
  }

  if (loading) return <div className="py-10 text-center text-muted-foreground">Loading…</div>
  if (!period) return <div className="py-10 text-center text-muted-foreground">Period not found.</div>

  const isLodged = period.status === 'LODGED'

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon" onClick={() => router.push('/admin/accounting/bas')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-semibold">{period.label || `Q${period.quarter} FY${period.financialYear}`}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground">{period.startDate} → {period.endDate}</span>
            <span className={cn('inline-flex px-2 py-0.5 rounded text-xs font-medium', STATUS_BADGE[period.status])}>
              {period.status}
            </span>
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <ExportMenu
            onExportCsv={() => {
              if (!calculation) return
              const rows = [
                ['G1 Total Sales', (calculation.g1TotalSalesCents / 100).toFixed(2)],
                ['G2 Export Sales', (calculation.g2ExportSalesCents / 100).toFixed(2)],
                ['G3 GST-Free Sales', (calculation.g3OtherGstFreeCents / 100).toFixed(2)],
                ['G10 Capital Purchases', (calculation.g10CapitalPurchasesCents / 100).toFixed(2)],
                ['G11 Non-Capital Purchases', (calculation.g11NonCapitalPurchasesCents / 100).toFixed(2)],
                ['1A GST Collected', (calculation.label1ACents / 100).toFixed(2)],
                ['1B GST Credits', (calculation.label1BCents / 100).toFixed(2)],
                ['Net GST', (calculation.netGstCents / 100).toFixed(2)],
              ]
              downloadCsv(`bas-${period.label || period.quarter}.csv`, ['Field', 'Amount'], rows)
            }}
            onExportPdf={() => downloadPdf(`BAS ${period.label || `Q${period.quarter}`}`)}
            disabled={!calculation}
          />
          {period.status === 'DRAFT' && (
            <Button variant="outline" onClick={() => handleStatusChange('REVIEWED')} disabled={saving}>
              <CheckCircle className="w-4 h-4 mr-1.5" />Mark Reviewed
            </Button>
          )}
          {period.status === 'REVIEWED' && (
            <Button onClick={() => setLodgeConfirm(true)} disabled={saving}>
              <FileCheck className="w-4 h-4 mr-1.5" />Lodge
            </Button>
          )}
        </div>
      </div>

      {/* Overrides & Notes */}
      {!isLodged && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Adjustments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="g2">G2 — Export Sales ($, override)</Label>
                <Input id="g2" type="number" step="0.01" value={g2Override} onChange={e => setG2Override(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="g3">G3 — GST-Free Sales ($, override)</Label>
                <Input id="g3" type="number" step="0.01" value={g3Override} onChange={e => setG3Override(e.target.value)} placeholder="0.00" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bas-notes">Notes</Label>
              <Textarea id="bas-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional notes" />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
              <Button onClick={handleCalculate} disabled={calculating}>
                <Calculator className="w-4 h-4 mr-1.5" />
                {calculating ? 'Calculating…' : 'Calculate'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLodged && (
        <Button variant="outline" onClick={handleCalculate} disabled={calculating}>
          <Calculator className="w-4 h-4 mr-1.5" />
          {calculating ? 'Calculating…' : 'Recalculate'}
        </Button>
      )}

      {/* Calculation Results */}
      {calculation && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">BAS Calculation ({calculation.basis})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              <BASRow label="G1 — Total Sales (inc GST)" cents={calculation.g1TotalSalesCents} />
              <BASRow label="G2 — Export Sales" cents={calculation.g2ExportSalesCents} muted />
              <BASRow label="G3 — GST-Free Sales" cents={calculation.g3OtherGstFreeCents} muted />
              <div className="my-2 border-t border-border" />
              <BASRow label="1A — GST on Sales" cents={calculation.label1ACents} bold />
              <div className="my-2 border-t border-border" />
              <BASRow label="G10 — Capital Purchases (inc GST)" cents={calculation.g10CapitalPurchasesCents} muted />
              <BASRow label="G11 — Non-Capital Purchases (inc GST)" cents={calculation.g11NonCapitalPurchasesCents} muted />
              <BASRow label="1B — GST Credits" cents={calculation.label1BCents} bold />
              <div className="my-2 border-t border-border" />
              <BASRow
                label={calculation.netGstCents >= 0 ? 'Net GST Payable' : 'Net GST Refund'}
                cents={calculation.netGstCents}
                bold
                highlight={calculation.netGstCents >= 0 ? 'payable' : 'refund'}
              />
            </div>

            {issues.length > 0 && (
              <div className="mt-4 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Issues</p>
                {issues.map((issue, i) => (
                  <div key={i} className={cn('text-xs px-2 py-1 rounded', issue.severity === 'warning' ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400' : 'bg-muted text-muted-foreground')}>
                    {issue.message}{issue.count != null ? ` (${issue.count})` : ''}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Lodge Confirmation */}
      <AlertDialog open={lodgeConfirm} onOpenChange={setLodgeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lodge BAS?</AlertDialogTitle>
            <AlertDialogDescription>
              Marking as Lodged is permanent — you cannot edit this period afterwards. Make sure the calculation is correct.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setLodgeConfirm(false); handleStatusChange('LODGED') }}>Lodge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function BASRow({ label, cents, muted, bold, highlight }: {
  label: string; cents: number; muted?: boolean; bold?: boolean; highlight?: 'payable' | 'refund'
}) {
  return (
    <div className={cn('flex justify-between py-0.5', muted && 'text-muted-foreground')}>
      <span className={cn(bold && 'font-semibold')}>{label}</span>
      <span className={cn(
        'tabular-nums',
        bold && 'font-semibold',
        highlight === 'payable' && 'text-red-600 dark:text-red-400',
        highlight === 'refund' && 'text-green-600 dark:text-green-400',
      )}>
        {fmtAud(Math.abs(cents))}
      </span>
    </div>
  )
}
