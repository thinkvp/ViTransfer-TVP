'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { apiFetch } from '@/lib/api-client'
import { ArrowLeft, Calculator, CheckCircle, FileCheck, AlertTriangle, Info, ChevronDown, ChevronUp, CreditCard, Trash2, Loader2 } from 'lucide-react'
import type { BasPeriod, BasCalculation, BasIssue, BasPeriodStatus, BasSalesRecord, BasExpenseRecord } from '@/lib/accounting/types'
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
  const [records, setRecords] = useState<{ sales: BasSalesRecord[], expenses: BasExpenseRecord[] } | null>(null)
  const [recordsTab, setRecordsTab] = useState<'sales' | 'expenses'>('sales')
  const [recordsExpanded, setRecordsExpanded] = useState(true)
  const [calculating, setCalculating] = useState(false)

  const [g2Override, setG2Override] = useState('')
  const [g3Override, setG3Override] = useState('')
  const [paygWithholding, setPaygWithholding] = useState('')
  const [paygInstalment, setPaygInstalment] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [lodgeConfirm, setLodgeConfirm] = useState(false)

  // Payment recording
  interface CoaOption { id: string; code: string; name: string; type: string }
  const [coaAccounts, setCoaAccounts] = useState<CoaOption[]>([])
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentDate, setPaymentDate] = useState('')
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [paymentAccountSearch, setPaymentAccountSearch] = useState('')
  const [paymentAccountOpen, setPaymentAccountOpen] = useState(false)
  const [paymentNotes, setPaymentNotes] = useState('')
  const [recordingPayment, setRecordingPayment] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const [deletePaymentConfirm, setDeletePaymentConfirm] = useState(false)
  const [deletingPayment, setDeletingPayment] = useState(false)

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
        setPaygWithholding(p.paygWithholdingCents != null ? (p.paygWithholdingCents / 100).toFixed(2) : '')
        setPaygInstalment(p.paygInstalmentCents != null ? (p.paygInstalmentCents / 100).toFixed(2) : '')
        setNotes(p.notes ?? '')
        // Restore saved calculation snapshot if available
        if (p.calculationJson) {
          setCalculation(p.calculationJson)
          setRecords(p.recordsJson ?? null)
        }
      }
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { void load() }, [load])

  // Load chart of accounts for payment dialog
  useEffect(() => {
    apiFetch('/api/admin/accounting/accounts?activeOnly=true')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.accounts) setCoaAccounts(d.accounts) })
      .catch(() => {})
  }, [])

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
        setRecords(d.records ?? null)
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
      body.paygWithholdingCents = paygWithholding ? Math.round(parseFloat(paygWithholding) * 100) : null
      body.paygInstalmentCents = paygInstalment ? Math.round(parseFloat(paygInstalment) * 100) : null
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
      const body: Record<string, unknown> = { status }
      // When lodging, include the current PAYG values so they're saved alongside the snapshot
      if (status === 'LODGED') {
        body.paygWithholdingCents = paygWithholding ? Math.round(parseFloat(paygWithholding) * 100) : null
        body.paygInstalmentCents = paygInstalment ? Math.round(parseFloat(paygInstalment) * 100) : null
      }
      const res = await apiFetch(`/api/admin/accounting/bas/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed'); return }
      await load()
    } finally { setSaving(false) }
  }

  async function handleRecordPayment() {
    if (!paymentDate || !paymentAmount || !paymentAccountId) {
      setPaymentError('Date, amount and account are required')
      return
    }
    const amountCents = Math.round(parseFloat(paymentAmount) * 100)
    if (!amountCents || amountCents <= 0) { setPaymentError('Enter a valid amount'); return }
    setRecordingPayment(true)
    setPaymentError('')
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${id}/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentDate, paymentAmountCents: amountCents, paymentNotes: paymentNotes.trim() || null, accountId: paymentAccountId }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setPaymentError(d.error || 'Failed'); return }
      setPaymentOpen(false)
      await load()
    } finally { setRecordingPayment(false) }
  }

  async function handleDeletePayment() {
    setDeletingPayment(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${id}/payment`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to remove payment'); return }
      setDeletePaymentConfirm(false)
      await load()
    } finally { setDeletingPayment(false) }
  }

  if (loading) return <div className="py-10 text-center text-muted-foreground">Loading…</div>
  if (!period) return <div className="py-10 text-center text-muted-foreground">Period not found.</div>

  const isLodged = period.status === 'LODGED'

  return (
    <div className="space-y-5">
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
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="payg-w2">W2 — PAYG Withholding ($)</Label>
                <Input id="payg-w2" type="number" step="0.01" value={paygWithholding} onChange={e => setPaygWithholding(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="payg-t4">T4 — PAYG Instalment ($)</Label>
                <Input id="payg-t4" type="number" step="0.01" value={paygInstalment} onChange={e => setPaygInstalment(e.target.value)} placeholder="0.00" />
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">PAYG Amounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between py-0.5">
              <span className="text-muted-foreground">W2 — PAYG Withholding</span>
              <span className="tabular-nums">{period.paygWithholdingCents != null ? fmtAud(period.paygWithholdingCents) : '—'}</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-muted-foreground">T4 — PAYG Instalment</span>
              <span className="tabular-nums">{period.paygInstalmentCents != null ? fmtAud(period.paygInstalmentCents) : '—'}</span>
            </div>
            {calculation && (
              <>
                <div className="my-2 border-t border-border" />
                <div className="flex justify-between py-0.5 font-semibold">
                  <span>Total Amount Payable to ATO</span>
                  <span className="tabular-nums text-red-600 dark:text-red-400">
                    {fmtAud(Math.max(0, calculation.netGstCents) + (period.paygWithholdingCents ?? 0) + (period.paygInstalmentCents ?? 0))}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Payment section — only for lodged periods */}
      {isLodged && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">BAS Payment</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {period.paymentDate ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1">
                  <div><p className="text-xs text-muted-foreground">Payment Date</p><p>{period.paymentDate}</p></div>
                  <div><p className="text-xs text-muted-foreground">Amount Paid</p><p className="font-medium">{period.paymentAmountCents != null ? fmtAud(period.paymentAmountCents) : '—'}</p></div>
                  {period.paymentNotes && <div className="col-span-2 sm:col-span-1"><p className="text-xs text-muted-foreground">Notes</p><p>{period.paymentNotes}</p></div>}
                </div>
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setDeletePaymentConfirm(true)}>
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />Remove Payment
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-muted-foreground text-sm">No payment recorded yet.</p>
                <Button size="sm" variant="outline" onClick={() => {
                  setPaymentDate(new Date().toISOString().slice(0, 10))
                  setPaymentAmount(calculation ? ((Math.max(0, calculation.netGstCents) + (period.paygWithholdingCents ?? 0) + (period.paygInstalmentCents ?? 0)) / 100).toFixed(2) : '')
                  setPaymentAccountId('')
                  setPaymentAccountSearch('')
                  setPaymentNotes('')
                  setPaymentError('')
                  setPaymentOpen(true)
                }}>
                  <CreditCard className="w-4 h-4 mr-1.5" />Record Payment
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
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

      {/* Source Records — drill-down */}
      {records && (records.sales.length > 0 || records.expenses.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <button
              type="button"
              className="flex items-center justify-between w-full text-left"
              onClick={() => setRecordsExpanded((v) => !v)}
            >
              <CardTitle className="text-sm">Source Records</CardTitle>
              {recordsExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </button>
          </CardHeader>
          {recordsExpanded && (
            <CardContent>
              {/* Tabs */}
              <div className="flex gap-2 mb-3">
                <Button
                  variant={recordsTab === 'sales' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setRecordsTab('sales')}
                >
                  Sales ({records.sales.length})
                </Button>
                <Button
                  variant={recordsTab === 'expenses' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setRecordsTab('expenses')}
                >
                  Expenses ({records.expenses.length})
                </Button>
              </div>

              {/* Sales records table */}
              {recordsTab === 'sales' && (
                <div className="border border-border rounded-md overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border">
                        <th className="text-left px-2 py-1.5 font-medium">Date</th>
                        <th className="text-left px-2 py-1.5 font-medium">Invoice</th>
                        <th className="text-left px-2 py-1.5 font-medium">Client</th>
                        <th className="text-right px-2 py-1.5 font-medium">Subtotal</th>
                        <th className="text-right px-2 py-1.5 font-medium">GST</th>
                        <th className="text-right px-2 py-1.5 font-medium">Total</th>
                        <th className="px-2 py-1.5 w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.sales.map((r, i) => (
                        <tr key={`${r.id}-${i}`} className="border-b border-border last:border-0 hover:bg-muted/30">
                          <td className="px-2 py-1.5">{r.date}</td>
                          <td className="px-2 py-1.5 font-medium">{r.invoiceNumber}</td>
                          <td className="px-2 py-1.5 text-muted-foreground max-w-[140px] truncate">{r.clientName}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(r.subtotalCents)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(r.gstCents)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-medium">{fmtAud(r.totalIncGstCents)}</td>
                          <td className="px-2 py-1.5 text-center">
                            {!r.taxEnabled && (
                              <span title="GST disabled on this invoice" className="text-yellow-600 dark:text-yellow-400">
                                <AlertTriangle className="w-3.5 h-3.5 inline" />
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-muted/40 border-t border-border font-semibold text-xs">
                        <td className="px-2 py-1.5" colSpan={3}>Totals</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(records.sales.reduce((s, r) => s + r.subtotalCents, 0))}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(records.sales.reduce((s, r) => s + r.gstCents, 0))}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(records.sales.reduce((s, r) => s + r.totalIncGstCents, 0))}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* Expenses records table */}
              {recordsTab === 'expenses' && (
                <div className="border border-border rounded-md overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border">
                        <th className="text-left px-2 py-1.5 font-medium">Date</th>
                        <th className="text-left px-2 py-1.5 font-medium">Supplier</th>
                        <th className="text-left px-2 py-1.5 font-medium">Description</th>
                        <th className="text-left px-2 py-1.5 font-medium">Account</th>
                        <th className="text-left px-2 py-1.5 font-medium">Tax Code</th>
                        <th className="text-right px-2 py-1.5 font-medium">Inc GST</th>
                        <th className="text-right px-2 py-1.5 font-medium">GST</th>
                        <th className="px-2 py-1.5 w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.expenses.map((r, i) => (
                        <tr key={`${r.id}-${i}`} className={cn(
                          'border-b border-border last:border-0 hover:bg-muted/30',
                          r.issue === 'zero_gst' && 'bg-yellow-500/5',
                        )}>
                          <td className="px-2 py-1.5">{r.date}</td>
                          <td className="px-2 py-1.5 text-muted-foreground max-w-[120px] truncate">{r.supplier ?? '—'}</td>
                          <td className="px-2 py-1.5 max-w-[160px] truncate" title={r.description}>{r.description}</td>
                          <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{r.accountCode}</td>
                          <td className="px-2 py-1.5">
                            <span className={cn(
                              'px-1.5 py-0.5 rounded text-[10px] font-medium',
                              r.taxCode === 'GST' ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                                : r.taxCode === 'GST_FREE' ? 'bg-muted text-muted-foreground'
                                : r.taxCode === 'BAS_EXCLUDED' ? 'bg-orange-500/15 text-orange-700 dark:text-orange-400'
                                : r.taxCode === 'INPUT_TAXED' ? 'bg-purple-500/15 text-purple-700 dark:text-purple-400'
                                : 'bg-muted text-muted-foreground',
                            )}>
                              {r.taxCode}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(r.amountIncGstCents)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(r.gstCents)}</td>
                          <td className="px-2 py-1.5 text-center">
                            {r.issue === 'zero_gst' && (
                              <span title="Coded GST but $0 GST amount" className="text-yellow-600 dark:text-yellow-400">
                                <AlertTriangle className="w-3.5 h-3.5 inline" />
                              </span>
                            )}
                            {r.issue === 'bas_excluded' && (
                              <span title="BAS Excluded — not claimed" className="text-orange-600 dark:text-orange-400">
                                <Info className="w-3.5 h-3.5 inline" />
                              </span>
                            )}
                            {r.issue === 'input_taxed' && (
                              <span title="Input Taxed — no GST credit" className="text-purple-600 dark:text-purple-400">
                                <Info className="w-3.5 h-3.5 inline" />
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-muted/40 border-t border-border font-semibold text-xs">
                        <td className="px-2 py-1.5" colSpan={5}>Totals</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(records.expenses.reduce((s, r) => s + r.amountIncGstCents, 0))}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(records.expenses.reduce((s, r) => s + r.gstCents, 0))}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </CardContent>
          )}
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

      {/* Record Payment Dialog */}
      <Dialog open={paymentOpen} onOpenChange={open => { if (!open && !recordingPayment) setPaymentOpen(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record BAS Payment</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <Label>Payment Date *</Label>
              <Input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Amount Paid ($) *</Label>
              <Input type="number" step="0.01" placeholder="0.00" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Account *</Label>
              <p className="text-xs text-muted-foreground">Select the account to record the payment against (e.g. ATO Integrated Client Account, GST Payable, or a tax expense account).</p>
              <div className="relative">
                <Input
                  placeholder="Search account…"
                  value={paymentAccountOpen ? paymentAccountSearch : (() => { const a = coaAccounts.find(x => x.id === paymentAccountId); return a ? `${a.type} — ${a.name}` : '' })()}
                  onFocus={() => { setPaymentAccountOpen(true); setPaymentAccountSearch('') }}
                  onBlur={() => setTimeout(() => setPaymentAccountOpen(false), 150)}
                  onChange={e => setPaymentAccountSearch(e.target.value)}
                />
                {paymentAccountOpen && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-52 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                    {coaAccounts.filter(a => {
                      const q = paymentAccountSearch.toLowerCase()
                      return !q || a.name.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) || a.code.toLowerCase().includes(q)
                    }).sort((a, b) => a.name.localeCompare(b.name)).map(a => (
                      <button key={a.id} type="button"
                        onMouseDown={() => { setPaymentAccountId(a.id); setPaymentAccountOpen(false); setPaymentAccountSearch('') }}
                        className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors', paymentAccountId === a.id && 'bg-primary/10 font-medium')}
                      >{a.type} — {a.name}</button>
                    ))}
                    {coaAccounts.filter(a => { const q = paymentAccountSearch.toLowerCase(); return !q || a.name.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) }).length === 0 && (
                      <p className="px-3 py-2 text-sm text-muted-foreground">No accounts found.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label>Notes <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input placeholder="e.g. Paid via BPAY" value={paymentNotes} onChange={e => setPaymentNotes(e.target.value)} />
            </div>
            {paymentError && <p className="text-destructive text-sm">{paymentError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentOpen(false)} disabled={recordingPayment}>Cancel</Button>
            <Button onClick={() => void handleRecordPayment()} disabled={recordingPayment || !paymentDate || !paymentAmount || !paymentAccountId}>
              {recordingPayment && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Record Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Payment Confirmation */}
      <AlertDialog open={deletePaymentConfirm} onOpenChange={setDeletePaymentConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Payment Record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the associated expense entry and clear the payment from this BAS period. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingPayment}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeletePayment()} disabled={deletingPayment} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
              {deletingPayment ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
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
