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
import { ArrowLeft, Calculator, CheckCircle, FileCheck, AlertTriangle, Info, ChevronDown, ChevronUp, CreditCard, Trash2, Loader2, ExternalLink } from 'lucide-react'
import type { BasPeriod, BasCalculation, BasIssue, BasPeriodStatus, BasSalesRecord, BasExpenseRecord, AccountingAttachment, JournalEntry } from '@/lib/accounting/types'
import { ExportMenu, downloadCsv, generateReportPdf } from '@/components/admin/accounting/ExportMenu'
import { AttachmentsPanel, type AttachmentItem } from '@/components/admin/accounting/AttachmentsPanel'
import { ExpenseFormModal } from '@/components/admin/accounting/ExpenseFormModal'
import { LinkedBankTransactionDialog } from '@/components/admin/accounting/LinkedBankTransactionDialog'
import { cn, formatDate } from '@/lib/utils'

function fmtAud(cents: number) {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `-$${abs}` : `$${abs}`
}

function truncateBasCents(cents: number) {
  const wholeDollarsCents = Math.floor(Math.abs(cents) / 100) * 100
  return cents < 0 ? -wholeDollarsCents : wholeDollarsCents
}

/** ATO BAS amounts must be reported in whole dollars (rounded down) */
function fmtBasDollars(cents: number) {
  const dollars = Math.abs(truncateBasCents(cents)) / 100
  const formatted = dollars.toLocaleString('en-AU')
  return cents < 0 ? `-$${formatted}` : `$${formatted}`
}

function fmtBasCsvAmount(cents: number) {
  const dollars = Math.abs(truncateBasCents(cents)) / 100
  return cents < 0 ? `-${dollars}` : String(dollars)
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
  const [defaultGstAccountId, setDefaultGstAccountId] = useState('')
  const [defaultPaygAccountId, setDefaultPaygAccountId] = useState('')
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentDate, setPaymentDate] = useState('')
  const [gstAmountStr, setGstAmountStr] = useState('')
  const [paygAmountStr, setPaygAmountStr] = useState('')
  const [gstAccountId, setGstAccountId] = useState('')
  const [gstAccountSearch, setGstAccountSearch] = useState('')
  const [gstAccountOpen, setGstAccountOpen] = useState(false)
  const [paygAccountId, setPaygAccountId] = useState('')
  const [paygAccountSearch, setPaygAccountSearch] = useState('')
  const [paygAccountOpen, setPaygAccountOpen] = useState(false)
  const [paymentNotes, setPaymentNotes] = useState('')
  const [recordingPayment, setRecordingPayment] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const [deletePaymentConfirm, setDeletePaymentConfirm] = useState(false)
  const [deletingPayment, setDeletingPayment] = useState(false)

  // Attachments
  const [attachments, setAttachments] = useState<AccountingAttachment[]>([])
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null)

  // Edit expense from BAS records drill-down
  const [editExpenseId, setEditExpenseId] = useState<string | null>(null)

  // View bank transaction from BAS records drill-down (MANUAL bank txn or split line rows)
  const [linkedTxnId, setLinkedTxnId] = useState<string | null>(null)

  // Edit journal entry from BAS records drill-down
  const [jeOpen, setJeOpen] = useState(false)
  const [editingJe, setEditingJe] = useState<JournalEntry | null>(null)
  const [jeDate, setJeDate] = useState('')
  const [jeDesc, setJeDesc] = useState('')
  const [jeAmount, setJeAmount] = useState('')
  const [jeType, setJeType] = useState<'debit' | 'credit'>('debit')
  const [jeTaxCode, setJeTaxCode] = useState('BAS_EXCLUDED')
  const [jeRef, setJeRef] = useState('')
  const [jeNotes, setJeNotes] = useState('')
  const [jeSaving, setJeSaving] = useState(false)

  async function openEditJournalEntry(jeId: string) {
    const res = await apiFetch(`/api/admin/accounting/journal-entries/${jeId}`)
    if (!res.ok) return
    const d = await res.json()
    const je: JournalEntry = d.entry
    setEditingJe(je)
    setJeDate(je.date)
    setJeDesc(je.description)
    setJeAmount((Math.abs(je.amountCents) / 100).toFixed(2))
    setJeType(je.amountCents < 0 ? 'credit' : 'debit')
    setJeTaxCode(je.taxCode)
    setJeRef(je.reference ?? '')
    setJeNotes(je.notes ?? '')
    setJeOpen(true)
  }

  async function handleSaveJournal() {
    if (!editingJe) return
    const cents = Math.round(parseFloat(jeAmount || '0') * 100)
    if (!cents || !jeDesc.trim()) return
    setJeSaving(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/journal-entries/${editingJe.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: jeDate,
          description: jeDesc.trim(),
          amountCents: jeType === 'credit' ? -cents : cents,
          taxCode: jeTaxCode,
          reference: jeRef.trim() || undefined,
          notes: jeNotes.trim() || undefined,
        }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to save journal entry'); return }
      setJeOpen(false)
      setEditingJe(null)
      if (calculation) void handleCalculate()
      else void load()
    } finally { setJeSaving(false) }
  }

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
        setAttachments(p.attachments ?? [])
      }
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { void load() }, [load])

  // Load chart of accounts and settings defaults for payment dialog
  useEffect(() => {
    apiFetch('/api/admin/accounting/accounts?activeOnly=true')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.accounts) setCoaAccounts(d.accounts) })
      .catch(() => {})
    apiFetch('/api/admin/accounting/settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          setDefaultGstAccountId(d.basGstAccountId ?? '')
          setDefaultPaygAccountId(d.basPaygAccountId ?? '')
        }
      })
      .catch(() => {})
  }, [])

  async function handleUploadAttachments(files: File[]) {
    setUploadingAttachment(true)
    try {
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await apiFetch(`/api/admin/accounting/bas/${id}/attachments`, { method: 'POST', body: fd })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || `Failed to upload "${file.name}"`)
        }
        const d = await res.json()
        setAttachments(prev => [...prev, ...(d.attachments ?? [])])
      }
    } finally {
      setUploadingAttachment(false)
    }
  }

  async function handleDownloadAttachment(attachmentId: string, filename: string) {
    try {
      const res = await apiFetch(`/api/admin/accounting/attachments/${attachmentId}`)
      if (!res.ok) { alert('Failed to download attachment'); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      alert('Failed to download attachment')
    }
  }

  async function handleDeleteAttachment(attachmentId: string) {
    setDeletingAttachmentId(attachmentId)
    try {
      const res = await apiFetch(`/api/admin/accounting/attachments/${attachmentId}`, { method: 'DELETE' })
      if (!res.ok) { alert('Failed to delete attachment'); return }
      setAttachments(prev => prev.filter(a => a.id !== attachmentId))
    } finally {
      setDeletingAttachmentId(null)
    }
  }

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
    const gstCents = Math.round(parseFloat(gstAmountStr) * 100)
    const paygCents = paygAmountStr ? Math.round(parseFloat(paygAmountStr) * 100) : 0
    if (!paymentDate) { setPaymentError('Payment date is required'); return }
    if (!gstCents || gstCents <= 0) { setPaymentError('Enter a valid GST amount'); return }
    if (!gstAccountId) { setPaymentError('Select a GST account'); return }
    if (paygCents > 0 && !paygAccountId) { setPaymentError('Select a PAYG account'); return }
    setRecordingPayment(true)
    setPaymentError('')
    try {
      const res = await apiFetch(`/api/admin/accounting/bas/${id}/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentDate,
          gstAmountCents: gstCents,
          paygAmountCents: paygCents,
          gstAccountId,
          paygAccountId: paygCents > 0 ? paygAccountId : null,
          paymentNotes: paymentNotes.trim() || null,
        }),
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
              const w2 = paygWithholding ? Math.round(parseFloat(paygWithholding) * 100) : 0
              const t7 = paygInstalment ? Math.round(parseFloat(paygInstalment) * 100) : 0
              const sum8A = truncateBasCents(calculation.label1ACents) + truncateBasCents(w2) + truncateBasCents(t7)
              const sum8B = truncateBasCents(calculation.label1BCents)
              const sum9 = sum8A - sum8B
              const rows: string[][] = [
                ['Total sales (including GST)', 'G1', fmtBasCsvAmount(calculation.g1TotalSalesCents)],
                ['GST you collected on sales', '1A', fmtBasCsvAmount(calculation.label1ACents)],
                ['GST you paid on purchases', '1B', fmtBasCsvAmount(calculation.label1BCents)],
              ]
              if (w2) rows.push(['Amount withheld from payments', 'W2', fmtBasCsvAmount(w2)])
              if (t7) rows.push(['Instalment amount', 'T7', fmtBasCsvAmount(t7)])
              rows.push(
                ['Amount you owe the ATO', '8A', fmtBasCsvAmount(sum8A)],
                ['Amount the ATO owes you', '8B', fmtBasCsvAmount(sum8B)],
                ['Your payment amount', '9', fmtBasCsvAmount(sum9)],
              )
              downloadCsv(`bas-${period.label || period.quarter}.csv`, ['Line Description', 'Line Code', 'Amount'], rows)
            }}
            onExportPdf={() => {
              if (!calculation) return
              const w2 = paygWithholding ? Math.round(parseFloat(paygWithholding) * 100) : 0
              const t7 = paygInstalment ? Math.round(parseFloat(paygInstalment) * 100) : 0
              const sum8A = truncateBasCents(calculation.label1ACents) + truncateBasCents(w2) + truncateBasCents(t7)
              const sum8B = truncateBasCents(calculation.label1BCents)
              const sum9 = sum8A - sum8B
              const cols = [
                { header: 'Line Description' },
                { header: 'Code', align: 'center' as const, nowrap: true },
                { header: 'Amount', align: 'right' as const, nowrap: true },
              ]
              const gstRows = [
                { cells: ['Total sales (including GST)', 'G1', fmtBasDollars(calculation.g1TotalSalesCents)] },
                { cells: ['GST you collected on sales', '1A', fmtBasDollars(calculation.label1ACents)], bold: true as const },
                { cells: ['GST you paid on purchases', '1B', fmtBasDollars(calculation.label1BCents)], bold: true as const },
              ]
              const paygRows = []
              if (w2) paygRows.push({ cells: ['Amount withheld from payments', 'W2', fmtBasDollars(w2)] })
              if (t7) paygRows.push({ cells: ['Instalment amount', 'T7', fmtBasDollars(t7)] })
              const summaryRows = [
                { cells: ['Amount you owe the ATO', '8A', fmtBasDollars(sum8A)], bold: true as const, separator: true as const },
                { cells: ['Amount the ATO owes you', '8B', fmtBasDollars(sum8B)], bold: true as const },
                { cells: ['Your payment amount', '9', fmtBasDollars(sum9)], bold: true as const, doubleSeparator: true as const, color: sum9 >= 0 ? 'red' : 'green' },
              ]
              const sections = [
                { title: 'GST', columns: cols, rows: gstRows },
                ...(paygRows.length > 0 ? [{ title: 'PAYG', columns: cols, rows: paygRows }] : []),
                { title: 'Summary', columns: cols, rows: summaryRows },
              ]
              generateReportPdf({ title: `BAS ${period.label || `Q${period.quarter} FY${period.financialYear}`}`, subtitle: `${period.startDate} to ${period.endDate} (${calculation.basis})`, sections })
            }}
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
                <Label htmlFor="payg-t7">T7 — Instalment Amount ($)</Label>
                <Input id="payg-t7" type="number" step="0.01" value={paygInstalment} onChange={e => setPaygInstalment(e.target.value)} placeholder="0.00" />
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

      {/* Payment section — only for lodged periods */}
      {isLodged && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">BAS Payment</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {period.paymentDate ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1">
                  <div><p className="text-xs text-muted-foreground">Payment Date</p><p>{period.paymentDate}</p></div>
                  <div><p className="text-xs text-muted-foreground">Total</p><p className="font-medium">{period.paymentAmountCents != null ? fmtAud(period.paymentAmountCents) : '—'}</p></div>
                  {period.paymentNotes && <div className="col-span-2 sm:col-span-1"><p className="text-xs text-muted-foreground">Notes</p><p>{period.paymentNotes}</p></div>}
                </div>
                {/* Component breakdown */}
                <div className="rounded border border-border divide-y divide-border text-xs">
                  <div className="flex justify-between px-3 py-1.5">
                    <span className="text-muted-foreground">GST net (1A − 1B)</span>
                    <span className="tabular-nums font-medium">{period.paymentGstCents != null ? fmtAud(period.paymentGstCents) : '—'}</span>
                  </div>
                  {(period.paymentPaygCents ?? 0) > 0 && (
                    <div className="flex justify-between px-3 py-1.5">
                      <span className="text-muted-foreground">PAYG Instalment (T7)</span>
                      <span className="tabular-nums font-medium">{fmtAud(period.paymentPaygCents!)}</span>
                    </div>
                  )}
                </div>
                {/* Bank reconciliation status */}
                <div className="flex items-center gap-2 text-xs">
                  {period.bankTransactionId ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-500/10 text-green-700 dark:text-green-400">
                      <CheckCircle className="w-3 h-3" />Bank reconciled
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-700 dark:text-yellow-400">
                      Awaiting bank match — match the ATO debit of {fmtAud(period.paymentAmountCents ?? 0)}{' '}in Bank Transactions as &ldquo;BAS Payment&rdquo;
                    </span>
                  )}
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
                  setGstAmountStr(calculation ? (Math.max(0, truncateBasCents(calculation.label1ACents) - truncateBasCents(calculation.label1BCents)) / 100).toFixed(2) : '')
                  setPaygAmountStr((period.paygInstalmentCents ?? 0) > 0 ? ((period.paygInstalmentCents ?? 0) / 100).toFixed(2) : '')
                  setGstAccountId(defaultGstAccountId)
                  setGstAccountSearch('')
                  setPaygAccountId(defaultPaygAccountId)
                  setPaygAccountSearch('')
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

      {/* Lodgement Documents */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Lodgement Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Attach a copy of the lodgement confirmation or BAS form received from the ATO portal after lodging.
          </p>
          <AttachmentsPanel
            items={attachments.map((a: AccountingAttachment) => ({ id: a.id, name: a.originalName }) satisfies AttachmentItem)}
            canUpload
            uploading={uploadingAttachment}
            deletingId={deletingAttachmentId}
            label={null}
            onUpload={handleUploadAttachments}
            onDownload={async (item: AttachmentItem) => { await handleDownloadAttachment(item.id, item.name) }}
            onDelete={async (item: AttachmentItem) => { await handleDeleteAttachment(item.id) }}
          />
        </CardContent>
      </Card>

      {/* Calculation Results — ATO BAS form layout */}
      {calculation && (() => {
        const w2Cents = paygWithholding ? Math.round(parseFloat(paygWithholding) * 100) : 0
        const t7Cents = paygInstalment ? Math.round(parseFloat(paygInstalment) * 100) : 0
        const label8ACents = truncateBasCents(calculation.label1ACents) + truncateBasCents(w2Cents) + truncateBasCents(t7Cents)
        const label8BCents = truncateBasCents(calculation.label1BCents)
        const label9Cents = label8ACents - label8BCents

        return (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">BAS Summary ({calculation.basis})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Line Description</th>
                      <th className="text-center py-2 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide w-28">Line Code</th>
                      <th className="text-right py-2 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide w-36">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* ── GST Section ─────────────────── */}
                    <tr className="bg-muted/30 border-b border-border">
                      <td className="px-4 py-1.5 font-semibold" colSpan={3}>GST</td>
                    </tr>
                    <BASTableRow description="Total sales (including GST)" lineCode="G1" cents={calculation.g1TotalSalesCents} />
                    <BASTableRow description="GST you collected on sales" lineCode="1A" cents={calculation.label1ACents} bold />
                    <BASTableRow description="GST you paid on purchases" lineCode="1B" cents={calculation.label1BCents} bold />

                    {/* ── PAYG Withholding Section ────── */}
                    {w2Cents !== 0 && (
                      <>
                        <tr className="bg-muted/30 border-t border-b border-border">
                          <td className="px-4 py-1.5 font-semibold" colSpan={3}>PAYG Withholding</td>
                        </tr>
                        <BASTableRow description="Amount withheld from payments" lineCode="W2" cents={w2Cents} />
                      </>
                    )}

                    {/* ── PAYG Income Tax Instalment ──── */}
                    {t7Cents !== 0 && (
                      <>
                        <tr className="bg-muted/30 border-t border-b border-border">
                          <td className="px-4 py-1.5 font-semibold" colSpan={3}>Income Tax Instalment</td>
                        </tr>
                        <BASTableRow description="Instalment amount" lineCode="T7" cents={t7Cents} />
                      </>
                    )}

                    {/* ── Summary Section ─────────────── */}
                    <tr className="bg-muted/30 border-t border-b border-border">
                      <td className="px-4 py-1.5 font-semibold" colSpan={3}>Summary</td>
                    </tr>
                    <BASTableRow description="Amount you owe the ATO" lineCode="8A" cents={label8ACents} bold />
                    <BASTableRow description="Amount the ATO owes you" lineCode="8B" cents={label8BCents} bold />
                    <BASTableRow
                      description="Your payment amount"
                      lineCode="9"
                      cents={label9Cents}
                      bold
                      highlight={label9Cents >= 0 ? 'payable' : 'refund'}
                    />
                  </tbody>
                </table>
              </div>

              {issues.length > 0 && (
                <div className="px-4 py-3 space-y-1 border-t border-border">
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
        )
      })()}

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
                        <tr key={`${r.id}-${i}`} className={cn('border-b border-border last:border-0', !isLodged && 'hover:bg-muted/30')}>
                          <td className="px-2 py-1.5">{formatDate(r.date)}</td>
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

              {/* Expenses records — grouped by tax code */}
              {recordsTab === 'expenses' && (() => {
                const TAX_CODE_ORDER = ['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']
                const TAX_CODE_LABEL: Record<string, string> = {
                  GST: 'GST',
                  GST_FREE: 'GST Free',
                  BAS_EXCLUDED: 'BAS Excluded',
                  INPUT_TAXED: 'Input Taxed',
                }
                const presentCodes = Array.from(new Set(records.expenses.map(r => r.taxCode)))
                const orderedCodes = [
                  ...TAX_CODE_ORDER.filter(c => presentCodes.includes(c)),
                  ...presentCodes.filter(c => !TAX_CODE_ORDER.includes(c)).sort(),
                ]
                return (
                  <div className="space-y-4">
                    {orderedCodes.map(code => {
                      const group = records.expenses.filter(r => r.taxCode === code)
                      if (group.length === 0) return null
                      return (
                        <div key={code}>
                          <p className="text-xs font-semibold text-muted-foreground mb-1.5">
                            <span className={cn(
                              'px-1.5 py-0.5 rounded text-[10px] font-medium mr-1.5',
                              code === 'GST' ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                                : code === 'GST_FREE' ? 'bg-muted text-muted-foreground'
                                : code === 'BAS_EXCLUDED' ? 'bg-orange-500/15 text-orange-700 dark:text-orange-400'
                                : code === 'INPUT_TAXED' ? 'bg-purple-500/15 text-purple-700 dark:text-purple-400'
                                : 'bg-muted text-muted-foreground',
                            )}>
                              {code}
                            </span>
                            {TAX_CODE_LABEL[code] ?? code}
                          </p>
                          <div className="border border-border rounded-md overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-muted/40 border-b border-border">
                                  <th className="text-left px-2 py-1.5 font-medium">Date</th>
                                  <th className="text-left px-2 py-1.5 font-medium">Supplier</th>
                                  <th className="text-left px-2 py-1.5 font-medium">Description</th>
                                  <th className="text-left px-2 py-1.5 font-medium">Account</th>
                                  <th className="text-right px-2 py-1.5 font-medium">Subtotal</th>
                                  <th className="text-right px-2 py-1.5 font-medium">GST</th>
                                  <th className="text-right px-2 py-1.5 font-medium">Total</th>
                                  <th className="px-2 py-1.5 w-8"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.map((r, i) => (
                                  <tr
                                    key={`${r.id}-${i}`}
                                    className={cn(
                                      'border-b border-border last:border-0',
                                      !isLodged && 'hover:bg-muted/30 cursor-pointer',
                                      r.issue === 'zero_gst' && 'bg-yellow-500/5',
                                    )}
                                    onClick={isLodged ? undefined : () => {
                                      if (r.kind === 'expense') { setEditExpenseId(r.id) }
                                      else if (r.kind === 'journal') { void openEditJournalEntry(r.id) }
                                      else if (r.kind === 'bankTransaction') { setLinkedTxnId(r.bankTransactionId ?? r.id) }
                                      else if (r.kind === 'splitLine') { setLinkedTxnId(r.bankTransactionId ?? null) }
                                    }}
                                  >
                                    <td className="px-2 py-1.5">{formatDate(r.date)}</td>
                                    <td className="px-2 py-1.5 text-muted-foreground max-w-[120px] truncate">{r.supplier ?? '—'}</td>
                                    <td className="px-2 py-1.5 max-w-[160px] truncate" title={r.description}>{r.description}</td>
                                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{r.accountCode}</td>
                                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(r.amountIncGstCents - r.gstCents)}</td>
                                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(r.gstCents)}</td>
                                    <td className="px-2 py-1.5 text-right tabular-nums font-medium">{fmtAud(r.amountIncGstCents)}</td>
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
                                  <td className="px-2 py-1.5" colSpan={4}>Total</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(group.reduce((s, r) => s + r.amountIncGstCents - r.gstCents, 0))}</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(group.reduce((s, r) => s + r.gstCents, 0))}</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtAud(group.reduce((s, r) => s + r.amountIncGstCents, 0))}</td>
                                  <td></td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
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
          <div className="space-y-4 text-sm">
            <div className="space-y-1">
              <Label>Payment Date *</Label>
              <Input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
            </div>

            {/* GST Component */}
            <div className="rounded-md border border-border p-3 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">GST — Net (1A − 1B)</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Amount ($) *</Label>
                  <Input type="number" step="0.01" placeholder="0.00" value={gstAmountStr} onChange={e => setGstAmountStr(e.target.value)} />
                </div>
                <div className="space-y-1 col-span-2">
                  <Label>Account *</Label>
                  <div className="relative">
                    <Input
                      placeholder="Search account…"
                      value={gstAccountOpen ? gstAccountSearch : (() => { const a = coaAccounts.find(x => x.id === gstAccountId); return a ? `${a.code} — ${a.name}` : '' })()}
                      onFocus={() => { setGstAccountOpen(true); setGstAccountSearch('') }}
                      onBlur={() => setTimeout(() => setGstAccountOpen(false), 150)}
                      onChange={e => setGstAccountSearch(e.target.value)}
                    />
                    {gstAccountOpen && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-48 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                        {coaAccounts.filter(a => { const q = gstAccountSearch.toLowerCase(); return !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) }).map(a => (
                          <button key={a.id} type="button"
                            onMouseDown={() => { setGstAccountId(a.id); setGstAccountOpen(false); setGstAccountSearch('') }}
                            className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors', gstAccountId === a.id && 'bg-primary/10 font-medium')}
                          >{a.code} — {a.name} <span className="text-xs text-muted-foreground ml-1">({a.type})</span></button>
                        ))}
                        {coaAccounts.filter(a => { const q = gstAccountSearch.toLowerCase(); return !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) }).length === 0 && (
                          <p className="px-3 py-2 text-sm text-muted-foreground">No accounts found.</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* PAYG Instalment Component — only shown if period has T7 */}
            {(period?.paygInstalmentCents ?? 0) > 0 && (
              <div className="rounded-md border border-border p-3 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">PAYG Income Tax Instalment (T7)</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Amount ($) *</Label>
                    <Input type="number" step="0.01" placeholder="0.00" value={paygAmountStr} onChange={e => setPaygAmountStr(e.target.value)} />
                  </div>
                  <div className="space-y-1 col-span-2">
                    <Label>Account *</Label>
                    <div className="relative">
                      <Input
                        placeholder="Search account…"
                        value={paygAccountOpen ? paygAccountSearch : (() => { const a = coaAccounts.find(x => x.id === paygAccountId); return a ? `${a.code} — ${a.name}` : '' })()}
                        onFocus={() => { setPaygAccountOpen(true); setPaygAccountSearch('') }}
                        onBlur={() => setTimeout(() => setPaygAccountOpen(false), 150)}
                        onChange={e => setPaygAccountSearch(e.target.value)}
                      />
                      {paygAccountOpen && (
                        <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-48 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                          {coaAccounts.filter(a => { const q = paygAccountSearch.toLowerCase(); return !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) }).map(a => (
                            <button key={a.id} type="button"
                              onMouseDown={() => { setPaygAccountId(a.id); setPaygAccountOpen(false); setPaygAccountSearch('') }}
                              className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors', paygAccountId === a.id && 'bg-primary/10 font-medium')}
                            >{a.code} — {a.name} <span className="text-xs text-muted-foreground ml-1">({a.type})</span></button>
                          ))}
                          {coaAccounts.filter(a => { const q = paygAccountSearch.toLowerCase(); return !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) }).length === 0 && (
                            <p className="px-3 py-2 text-sm text-muted-foreground">No accounts found.</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Total */}
            {(() => {
              const g = parseFloat(gstAmountStr) || 0
              const p = parseFloat(paygAmountStr) || 0
              const total = g + p
              return total > 0 ? (
                <div className="flex justify-between items-center border-t border-border pt-3">
                  <span className="text-muted-foreground">Total payment</span>
                  <span className="font-semibold tabular-nums">{fmtAud(Math.round(total * 100))}</span>
                </div>
              ) : null
            })()}

            <div className="space-y-1">
              <Label>Notes <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input placeholder="e.g. Paid via BPAY" value={paymentNotes} onChange={e => setPaymentNotes(e.target.value)} />
            </div>
            {paymentError && <p className="text-destructive text-sm">{paymentError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentOpen(false)} disabled={recordingPayment}>Cancel</Button>
            <Button onClick={() => void handleRecordPayment()} disabled={recordingPayment || !paymentDate || !gstAmountStr || !gstAccountId}>
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

      {/* Edit Expense Modal — expense rows in the BAS drill-down (draft/reviewed only) */}
      {!isLodged && (
        <ExpenseFormModal
          open={editExpenseId !== null}
          expenseId={editExpenseId}
          onClose={() => setEditExpenseId(null)}
          onSaved={() => {
            setEditExpenseId(null)
            // Re-run calculation so the BAS summary and records tables reflect the saved changes
            if (calculation) void handleCalculate()
            else void load()
          }}
        />
      )}

      {/* View Bank Transaction — MANUAL bank txn and split line rows (draft/reviewed only) */}
      {!isLodged && (
        <LinkedBankTransactionDialog
          open={linkedTxnId !== null}
          transactionId={linkedTxnId}
          onOpenChange={open => { if (!open) setLinkedTxnId(null) }}
          onViewExpense={expenseId => { setLinkedTxnId(null); setEditExpenseId(expenseId) }}
        />
      )}

      {/* Edit Journal Entry — journal rows in the BAS drill-down (draft/reviewed only) */}
      <Dialog open={!isLodged && jeOpen} onOpenChange={open => { if (!open && !jeSaving) { setJeOpen(false); setEditingJe(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Journal Entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Date</Label>
                <Input type="date" value={jeDate} onChange={e => setJeDate(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Tax Code</Label>
                <Select value={jeTaxCode} onValueChange={setJeTaxCode}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GST">GST (10%)</SelectItem>
                    <SelectItem value="GST_FREE">GST Free</SelectItem>
                    <SelectItem value="BAS_EXCLUDED">BAS Excluded</SelectItem>
                    <SelectItem value="INPUT_TAXED">Input Taxed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Input value={jeDesc} onChange={e => setJeDesc(e.target.value)} placeholder="Description" className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount (inc. GST)</Label>
                <Input type="number" min="0" step="0.01" value={jeAmount} onChange={e => setJeAmount(e.target.value)} placeholder="0.00" className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Direction</Label>
                <Select value={jeType} onValueChange={v => setJeType(v as 'debit' | 'credit')}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="debit">Debit (+)</SelectItem>
                    <SelectItem value="credit">Credit (−)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">Reference</Label>
              <Input value={jeRef} onChange={e => setJeRef(e.target.value)} placeholder="Optional reference" className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Notes</Label>
              <Textarea value={jeNotes} onChange={e => setJeNotes(e.target.value)} placeholder="Optional notes" className="mt-1" rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setJeOpen(false); setEditingJe(null) }} disabled={jeSaving}>Cancel</Button>
            <Button onClick={() => void handleSaveJournal()} disabled={jeSaving || !jeDesc.trim() || !jeAmount}>
              {jeSaving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BASTableRow({ description, lineCode, cents, bold, highlight }: {
  description: string; lineCode: string; cents: number; bold?: boolean; highlight?: 'payable' | 'refund'
}) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className={cn('px-4 py-1.5 pl-8', bold && 'font-semibold')}>{description}</td>
      <td className="px-4 py-1.5 text-center">
        <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">{lineCode}</span>
      </td>
      <td className={cn(
        'px-4 py-1.5 text-right tabular-nums',
        bold && 'font-semibold',
        highlight === 'payable' && 'text-red-600 dark:text-red-400',
        highlight === 'refund' && 'text-green-600 dark:text-green-400',
      )}>
        {fmtBasDollars(cents)}
      </td>
    </tr>
  )
}
