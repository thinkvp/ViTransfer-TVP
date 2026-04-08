'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Trash2, CheckCircle } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import type { Expense, AccountTaxCode, ExpenseStatus, AccountingAttachment } from '@/lib/accounting/types'
import { TAX_CODE_LABELS, EXPENSE_STATUS_LABELS } from '@/lib/accounting/types'
import { AttachmentsPanel, type AttachmentItem } from '@/components/admin/accounting/AttachmentsPanel'
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

interface ExpenseFormModalProps {
  open: boolean
  expenseId?: string | null
  onClose: () => void
  onSaved?: (expense: Expense) => void
  onDeleted?: () => void
}

export function ExpenseFormModal({ open, expenseId, onClose, onSaved, onDeleted }: ExpenseFormModalProps) {
  const isNew = !expenseId

  const [loading, setLoading] = useState(false)
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

  const [receiptFiles, setReceiptFiles] = useState<File[]>([])
  const [uploadingReceipt, setUploadingReceipt] = useState(false)
  const [uploadingAttachmentId, setUploadingAttachmentId] = useState<string | null>(null)
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null)

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

  // Reset & load when modal opens
  useEffect(() => {
    if (!open) return
    setError('')
    setShowDeleteDialog(false)
    setReceiptFiles([])
    if (isNew) {
      setExpense(null)
      setForm({
        date: new Date().toISOString().slice(0, 10),
        supplierName: '',
        description: '',
        accountId: '',
        taxCode: 'GST',
        amountIncGst: '',
        notes: '',
      })
    }
    void loadAccounts()
    void loadExpense()
  }, [open, isNew, loadAccounts, loadExpense])

  async function handleSave() {
    setError('')
    setSaving(true)
    try {
      if (!form.description.trim()) { setError('Enter a description'); return }

      let body: Record<string, unknown>
      if (isFinancialLocked) {
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
      const savedId = expenseId ?? (saved.expense?.id as string | undefined)

      if (receiptFiles.length > 0 && savedId) {
        setUploadingReceipt(true)
        for (const file of receiptFiles) {
          const fd = new FormData()
          fd.append('file', file)
          await apiFetch(`/api/admin/accounting/expenses/${savedId}/attachments`, { method: 'POST', body: fd })
        }
        setUploadingReceipt(false)
      }

      onSaved?.(saved.expense as Expense)
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

  async function downloadAccountingAttachment(attachmentId: string, filename: string) {
    try {
      const res = await apiFetch(`/api/admin/accounting/attachments/${attachmentId}`)
      if (!res.ok) { alert('Failed to download'); return }
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
      alert('Failed to download')
    }
  }

  async function handleDeleteAccountingAttachment(attachmentId: string) {
    if (!expenseId) return
    setDeletingAttachmentId(attachmentId)
    try {
      const res = await apiFetch(`/api/admin/accounting/attachments/${attachmentId}`, { method: 'DELETE' })
      if (res.ok) {
        setExpense(prev => prev ? { ...prev, attachments: (prev.attachments ?? []).filter((a: AccountingAttachment) => a.id !== attachmentId) } : prev)
      }
    } finally {
      setDeletingAttachmentId(null)
    }
  }

  async function handleUploadAttachments(files: File[]) {
    if (!expenseId) return
    setUploadingAttachmentId(expenseId)
    try {
      const newAttachments: AccountingAttachment[] = []
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await apiFetch(`/api/admin/accounting/expenses/${expenseId}/attachments`, { method: 'POST', body: fd })
        if (res.ok) {
          const data = await res.json()
          newAttachments.push(...(data.attachments ?? []))
        }
      }
      if (newAttachments.length > 0) {
        setExpense(prev => prev ? { ...prev, attachments: [...(prev.attachments ?? []), ...newAttachments] } : prev)
      }
    } finally {
      setUploadingAttachmentId(null)
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
      setShowDeleteDialog(false)
      onDeleted?.()
    } finally {
      setDeleting(false)
    }
  }

  const isFinancialLocked = expense?.status === 'RECONCILED'

  return (
    <>
      <Dialog open={open} onOpenChange={v => { if (!v && !saving && !deleting) onClose() }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between gap-3 pr-6">
              <div className="flex items-center gap-2">
                <DialogTitle>{isNew ? 'New Expense' : 'Edit Expense'}</DialogTitle>
                {expense && (
                  <span className={cn('inline-flex px-2 py-0.5 rounded text-xs font-medium', STATUS_BADGE[expense.status] ?? '')}>
                    {EXPENSE_STATUS_LABELS[expense.status] ?? expense.status}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {expense?.status === 'DRAFT' && (
                  <Button variant="outline" size="sm" onClick={() => void handleApprove()} disabled={saving}>
                    <CheckCircle className="w-4 h-4 mr-1.5" />Approve
                  </Button>
                )}
                {expense && expense.status !== 'RECONCILED' && !expense.bankTransactionId && (
                  <Button variant="outline" size="sm" onClick={() => setShowDeleteDialog(true)} disabled={saving} className="text-destructive border-destructive/40 hover:bg-destructive/10">
                    <Trash2 className="w-4 h-4 mr-1.5" />Delete
                  </Button>
                )}
              </div>
            </div>
          </DialogHeader>

          {loading ? (
            <div className="py-8 text-center text-muted-foreground">Loading…</div>
          ) : (
            <div className="space-y-4 pt-1">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="ef-date">Date *</Label>
                  <Input id="ef-date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} disabled={isFinancialLocked} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ef-supplier">Supplier</Label>
                  <Input id="ef-supplier" value={form.supplierName} onChange={e => setForm(f => ({ ...f, supplierName: e.target.value }))} placeholder="Supplier name (optional)" />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="ef-desc">Description *</Label>
                <Input id="ef-desc" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Description of expense" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="ef-account">Account *</Label>
                  <Select value={form.accountId} onValueChange={v => setForm(f => ({ ...f, accountId: v }))} disabled={isFinancialLocked}>
                    <SelectTrigger id="ef-account"><SelectValue placeholder="Select account" /></SelectTrigger>
                    <SelectContent>
                      {accounts.map(a => (
                        <SelectItem key={a.id} value={a.id}>{a.code} — {a.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ef-taxcode">Tax Code</Label>
                  <Select value={form.taxCode} onValueChange={v => setForm(f => ({ ...f, taxCode: v as AccountTaxCode }))} disabled={isFinancialLocked}>
                    <SelectTrigger id="ef-taxcode"><SelectValue /></SelectTrigger>
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
                  <Label htmlFor="ef-amount">Amount inc. GST ($) *</Label>
                  <Input id="ef-amount" type="number" step="0.01" min="0" value={form.amountIncGst} onChange={e => setForm(f => ({ ...f, amountIncGst: e.target.value }))} placeholder="0.00" disabled={isFinancialLocked} />
                </div>
                {!isNew && expense && (
                  <div className="space-y-1 pt-6 text-sm text-muted-foreground">
                    <div>Ex-GST: <span className="font-medium text-foreground">${fmtAud(expense.amountExGst)}</span></div>
                    <div>GST: <span className="font-medium text-foreground">${fmtAud(expense.gstAmount)}</span></div>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor="ef-notes">Notes</Label>
                <Textarea id="ef-notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" rows={2} />
              </div>

              <div className="space-y-2">
                <Label>Attachments</Label>
                {expenseId ? (
                  <AttachmentsPanel
                    items={(expense?.attachments ?? []).map((a: AccountingAttachment) => ({ id: a.id, name: a.originalName }) satisfies AttachmentItem)}
                    canUpload
                    uploading={uploadingAttachmentId !== null}
                    deletingId={deletingAttachmentId ?? undefined}
                    onUpload={handleUploadAttachments}
                    onDownload={async (item: AttachmentItem) => {
                      await downloadAccountingAttachment(item.id, item.name)
                    }}
                    onDelete={async (item: AttachmentItem) => {
                      await handleDeleteAccountingAttachment(item.id)
                    }}
                  />
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-col gap-1">
                      {receiptFiles.map((f, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          <span className="truncate max-w-xs">{f.name}</span>
                          <button type="button" onClick={() => setReceiptFiles(prev => prev.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">&times;</button>
                        </div>
                      ))}
                    </div>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground">
                      + Add files
                      <input
                        type="file"
                        accept="image/*,application/pdf"
                        multiple
                        className="sr-only"
                        onChange={e => { if (e.target.files) { setReceiptFiles(prev => [...prev, ...Array.from(e.target.files!)]) } e.target.value = '' }}
                      />
                    </label>
                  </div>
                )}
              </div>

              {isFinancialLocked && (
                <p className="text-xs text-muted-foreground">Financial fields are locked for reconciled expenses. You can still update supplier, description, notes, and attachments.</p>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-2 pt-2 justify-end">
                <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                <Button
                  onClick={() => void handleSave()}
                  disabled={saving || uploadingReceipt || uploadingAttachmentId !== null || !form.description.trim() || (!isFinancialLocked && !form.amountIncGst)}
                >
                  {saving || uploadingReceipt ? 'Saving…' : (isNew ? 'Create Expense' : 'Save Changes')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
    </>
  )
}
