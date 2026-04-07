'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/lib/api-client'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { ArrowLeft, Upload, Trash2, CheckCircle, FileText } from 'lucide-react'
import type { Expense, AccountTaxCode, ExpenseStatus } from '@/lib/accounting/types'
import { TAX_CODE_LABELS, EXPENSE_STATUS_LABELS } from '@/lib/accounting/types'
import { buildAccountOptions, type AccountOption } from '@/lib/accounting/account-options'
import { cn } from '@/lib/utils'

function fmtAud(cents: number) {
  return (cents / 100).toFixed(2)
}

const STATUS_BADGE: Record<ExpenseStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  APPROVED: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  RECONCILED: 'bg-green-500/15 text-green-700 dark:text-green-400',
}

export default function ExpenseFormPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const isNew = !params?.id || params.id === 'new'
  const expenseId = params?.id && params.id !== 'new' ? params.id : null

  const [loading, setLoading] = useState(!isNew)
  const [expense, setExpense] = useState<Expense | null>(null)
  const [accounts, setAccounts] = useState<AccountOption[]>([])

  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    supplierName: '',
    description: '',
    accountId: '',
    taxCode: 'GST' as AccountTaxCode,
    amountIncGst: '',
    notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [error, setError] = useState('')

  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [uploadingReceipt, setUploadingReceipt] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadAccounts = useCallback(async () => {
    const res = await apiFetch('/api/admin/accounting/accounts?expenseTypes=true&activeOnly=true')
    if (res.ok) {
      const data = await res.json()
      setAccounts(buildAccountOptions(data.accounts ?? []))
    }
  }, [])

  const loadExpense = useCallback(async () => {
    if (!expenseId) return
    setLoading(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/expenses/${expenseId}`)
      if (res.ok) {
        const data = await res.json()
        const e: Expense = data.expense
        setExpense(e)
        setForm({
          date: e.date,
          supplierName: e.supplierName ?? '',
          description: e.description,
          accountId: e.accountId,
          taxCode: e.taxCode,
          amountIncGst: fmtAud(e.amountIncGst),
          notes: e.notes ?? '',
        })
      }
    } finally {
      setLoading(false)
    }
  }, [expenseId])

  useEffect(() => {
    void loadAccounts()
    void loadExpense()
  }, [loadAccounts, loadExpense])

  async function handleSave() {
    setError('')
    setSaving(true)
    try {
      if (!form.description.trim()) { setError('Enter a description'); return }

      let body: Record<string, unknown>
      if (isFinancialLocked) {
        // Reconciled: only non-financial fields can change
        body = {
          description: form.description.trim(),
          supplierName: form.supplierName.trim() || null,
          notes: form.notes.trim() || null,
        }
      } else {
        const parsedAmount = parseFloat(form.amountIncGst)
        if (isNaN(parsedAmount) || parsedAmount <= 0) { setError('Enter a valid amount'); return }
        if (!form.accountId) { setError('Select an account'); return }
        body = {
          date: form.date,
          supplierName: form.supplierName.trim() || null,
          description: form.description.trim(),
          accountId: form.accountId,
          taxCode: form.taxCode,
          amountIncGst: parsedAmount,
          notes: form.notes.trim() || null,
        }
      }

      const url = expenseId ? `/api/admin/accounting/expenses/${expenseId}` : '/api/admin/accounting/expenses'
      const method = expenseId ? 'PUT' : 'POST'
      const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to save')
        return
      }
      const saved = await res.json()
      const savedId = expenseId ?? saved.expense?.id
      // Upload receipt if selected
      if (receiptFile && savedId) {
        setUploadingReceipt(true)
        const fd = new FormData()
        fd.append('file', receiptFile)
        await apiFetch(`/api/admin/accounting/expenses/${savedId}/receipt`, { method: 'POST', body: fd })
        setUploadingReceipt(false)
      }
      router.push('/admin/accounting/expenses')
    } finally {
      setSaving(false)
    }
  }

  async function handleApprove() {
    if (!expenseId) return
    setSaving(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/expenses/${expenseId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'APPROVED' }),
      })
      if (res.ok) await loadExpense()
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteReceipt() {
    if (!expenseId) return
    const res = await apiFetch(`/api/admin/accounting/expenses/${expenseId}/receipt`, { method: 'DELETE' })
    if (res.ok) await loadExpense()
  }

  async function handleDownloadReceipt() {
    if (!expenseId || !expense?.receiptPath) return
    try {
      const res = await apiFetch(`/api/admin/accounting/expenses/${expenseId}/receipt`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || 'Failed to download receipt')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = expense.receiptOriginalName ?? 'receipt'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      alert('Failed to download receipt')
    }
  }

  async function handleDelete() {
    if (!expenseId) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/expenses/${expenseId}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || 'Failed to delete')
        return
      }
      router.push('/admin/accounting/expenses')
    } finally {
      setDeleting(false)
      setShowDeleteDialog(false)
    }
  }

  // Financial fields (amount, date, account, taxCode) are locked once reconciled.
  // Non-financial fields (supplier, description, notes, receipt) remain editable.
  const isFinancialLocked = expense?.status === 'RECONCILED'

  if (loading) return <div className="py-10 text-center text-muted-foreground">Loading…</div>

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push('/admin/accounting/expenses')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-semibold">{isNew ? 'New Expense' : 'Edit Expense'}</h2>
          {expense && (
            <span className={cn('inline-flex px-2 py-0.5 rounded text-xs font-medium mt-0.5', STATUS_BADGE[expense.status])}>
              {EXPENSE_STATUS_LABELS[expense.status]}
            </span>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          {expense?.status === 'DRAFT' && (
            <Button variant="outline" onClick={handleApprove} disabled={saving}>
              <CheckCircle className="w-4 h-4 mr-1.5" />Approve
            </Button>
          )}
          {expense && expense.status !== 'RECONCILED' && !expense.bankTransactionId && (
            <Button variant="outline" onClick={() => setShowDeleteDialog(true)} disabled={saving} className="text-destructive border-destructive/40 hover:bg-destructive/10">
              <Trash2 className="w-4 h-4 mr-1.5" />Delete
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="exp-date">Date *</Label>
              <Input id="exp-date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} disabled={isFinancialLocked} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="exp-supplier">Supplier</Label>
              <Input id="exp-supplier" value={form.supplierName} onChange={e => setForm(f => ({ ...f, supplierName: e.target.value }))} placeholder="Supplier name (optional)" />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="exp-desc">Description *</Label>
            <Input id="exp-desc" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Description of expense" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="exp-account">Account *</Label>
              <Select value={form.accountId} onValueChange={v => setForm(f => ({ ...f, accountId: v }))} disabled={isFinancialLocked}>
                <SelectTrigger id="exp-account"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map(a => (
                    <SelectItem key={a.id} value={a.id}>{a.code} — {a.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="exp-taxcode">Tax Code</Label>
              <Select value={form.taxCode} onValueChange={v => setForm(f => ({ ...f, taxCode: v as AccountTaxCode }))} disabled={isFinancialLocked}>
                <SelectTrigger id="exp-taxcode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.entries(TAX_CODE_LABELS) as [AccountTaxCode, string][]).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="exp-amount">Amount inc. GST ($) *</Label>
              <Input id="exp-amount" type="number" step="0.01" min="0" value={form.amountIncGst} onChange={e => setForm(f => ({ ...f, amountIncGst: e.target.value }))} placeholder="0.00" disabled={isFinancialLocked} />
            </div>
            {!isNew && expense && (
              <div className="space-y-1 pt-6 text-sm text-muted-foreground">
                <div>Ex-GST: <span className="font-medium text-foreground">${fmtAud(expense.amountExGst)}</span></div>
                <div>GST: <span className="font-medium text-foreground">${fmtAud(expense.gstAmount)}</span></div>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="exp-notes">Notes</Label>
            <Textarea id="exp-notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" rows={2} />
          </div>

          {/* Receipt */}
          <div className="space-y-2">
            <Label>Receipt</Label>
            {expense?.receiptPath ? (
              <div className="flex items-center gap-2 text-sm">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => void handleDownloadReceipt()}
                  className="text-primary hover:underline text-sm"
                >
                  {expense.receiptOriginalName ?? 'Download receipt'}
                </button>
                <Button variant="ghost" size="sm" className="h-7 text-destructive" onClick={handleDeleteReceipt}>
                  <Trash2 className="w-3.5 h-3.5 mr-1" />Remove
                </Button>
              </div>
            ) : (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={e => setReceiptFile(e.target.files?.[0] ?? null)}
                />
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="w-3.5 h-3.5 mr-1.5" />
                  {receiptFile ? receiptFile.name : 'Upload receipt'}
                </Button>
              </div>
            )}
          </div>

          {isFinancialLocked && (
            <p className="text-xs text-muted-foreground">Financial fields are locked for reconciled expenses. You can still update supplier, description, notes, and receipt.</p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2 pt-2">
            <Button
              onClick={handleSave}
              disabled={saving || uploadingReceipt || !form.description.trim() || (!isFinancialLocked && !form.amountIncGst)}
            >
              {saving || uploadingReceipt ? 'Saving…' : (isNew ? 'Create Expense' : 'Save Changes')}
            </Button>
            <Button variant="outline" onClick={() => router.push('/admin/accounting/expenses')}>Cancel</Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showDeleteDialog} onOpenChange={v => { if (!deleting) setShowDeleteDialog(v) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete expense?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>{expense?.supplierName ?? expense?.description}</strong>? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
