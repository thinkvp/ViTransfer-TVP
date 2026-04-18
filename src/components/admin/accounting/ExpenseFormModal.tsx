'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Trash2, CheckCircle, Paperclip, X } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import type { Expense, AccountTaxCode, ExpenseStatus, AccountingAttachment, BankTransaction } from '@/lib/accounting/types'
import { TAX_CODE_LABELS, EXPENSE_STATUS_LABELS } from '@/lib/accounting/types'
import { LinkedBankTransactionDialog } from '@/components/admin/accounting/LinkedBankTransactionDialog'
import { AttachmentsPanel, type AttachmentItem } from '@/components/admin/accounting/AttachmentsPanel'
import { buildAccountOptions, type AccountOption } from '@/lib/accounting/account-options'
import { cn } from '@/lib/utils'

function NewExpenseDropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  return (
    <div className="space-y-1">
      <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple className="hidden"
        onChange={e => { onFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragEnter={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); onFiles(Array.from(e.dataTransfer.files)) }}
        className={cn(
          'flex items-center justify-center gap-1.5 border border-dashed rounded px-3 py-2 text-xs transition-colors cursor-pointer',
          dragOver ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
        )}
      >
        <Paperclip className="w-3.5 h-3.5 shrink-0" />
        <span>Drop files or click to attach</span>
      </div>
    </div>
  )
}

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
  onExpenseChanged?: (expense: Expense) => void
  onDeleted?: () => void
}

export function ExpenseFormModal({ open, expenseId, onClose, onSaved, onExpenseChanged, onDeleted }: ExpenseFormModalProps) {
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
  const [accountSearch, setAccountSearch] = useState('')
  const [accountOpen, setAccountOpen] = useState(false)
  const [linkedTransactionId, setLinkedTransactionId] = useState<string | null>(null)
  const [linkedTransactionAttachments, setLinkedTransactionAttachments] = useState<AccountingAttachment[]>([])
  const [loadingLinkedTransactionAttachments, setLoadingLinkedTransactionAttachments] = useState(false)

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
        onExpenseChanged?.(e)
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
  }, [expenseId, onExpenseChanged])

  const loadLinkedTransactionAttachments = useCallback(async (transactionId: string | null | undefined) => {
    if (!transactionId) {
      setLinkedTransactionAttachments([])
      setLoadingLinkedTransactionAttachments(false)
      return
    }

    setLoadingLinkedTransactionAttachments(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${transactionId}`)
      if (!res.ok) {
        setLinkedTransactionAttachments([])
        return
      }
      const data = await res.json()
      const transaction = data.transaction as BankTransaction | null
      setLinkedTransactionAttachments(transaction?.attachments ?? [])
    } finally {
      setLoadingLinkedTransactionAttachments(false)
    }
  }, [])

  // Reset & load when modal opens
  useEffect(() => {
    if (!open) return
    setError('')
    setShowDeleteDialog(false)
    setReceiptFiles([])
    setAccountSearch('')
    setAccountOpen(false)
    setLinkedTransactionAttachments([])
    setLoadingLinkedTransactionAttachments(false)
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

  useEffect(() => {
    if (!open || !expense?.bankTransactionId) {
      setLinkedTransactionAttachments([])
      setLoadingLinkedTransactionAttachments(false)
      return
    }
    void loadLinkedTransactionAttachments(expense.bankTransactionId)
  }, [open, expense?.bankTransactionId, loadLinkedTransactionAttachments])

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
          const uploadRes = await apiFetch(`/api/admin/accounting/expenses/${savedId}/attachments`, { method: 'POST', body: fd })
          if (!uploadRes.ok) {
            const d = await uploadRes.json().catch(() => ({}))
            setError(d.error || `Failed to upload attachment "${file.name}"`)
            setUploadingReceipt(false)
            return
          }
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
    if (!confirm('Delete this attachment? This cannot be undone.')) return
    setDeletingAttachmentId(attachmentId)
    try {
      const res = await apiFetch(`/api/admin/accounting/attachments/${attachmentId}`, { method: 'DELETE' })
      if (res.ok) {
        setExpense(prev => {
          if (!prev) return prev
          const nextExpense = {
            ...prev,
            attachments: (prev.attachments ?? []).filter((a: AccountingAttachment) => a.id !== attachmentId),
          }
          onExpenseChanged?.(nextExpense)
          return nextExpense
        })
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
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          setError(d.error || `Failed to upload attachment "${file.name}"`)
          return
        }
        const data = await res.json()
        newAttachments.push(...(data.attachments ?? []))
      }
      if (newAttachments.length > 0) {
        setExpense(prev => {
          if (!prev) return prev
          const nextExpense = {
            ...prev,
            attachments: [...(prev.attachments ?? []), ...newAttachments],
          }
          onExpenseChanged?.(nextExpense)
          return nextExpense
        })
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
  const selectedAccount = accounts.find(account => account.id === form.accountId) ?? null
  const filteredAccounts = accounts.filter(account => {
    const query = accountSearch.trim().toLowerCase()
    return !query || account.searchText.includes(query)
  })

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
              {isFinancialLocked && (
                <p className="text-xs text-muted-foreground">Financial fields are locked for reconciled expenses. You can still update supplier, description, notes, and attachments.</p>
              )}

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

              <div className="space-y-1">
                <Label htmlFor="ef-account">Account *</Label>
                <div className="relative">
                  <Input
                    id="ef-account"
                    value={accountOpen ? accountSearch : (selectedAccount?.label ?? '')}
                    onFocus={() => {
                      if (isFinancialLocked) return
                      setAccountOpen(true)
                      setAccountSearch('')
                    }}
                    onBlur={() => setTimeout(() => setAccountOpen(false), 150)}
                    onChange={e => setAccountSearch(e.target.value)}
                    placeholder="Search account…"
                    disabled={isFinancialLocked}
                  />
                  {accountOpen && !isFinancialLocked && (
                    <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-52 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                      {filteredAccounts.map(account => (
                        <button
                          key={account.id}
                          type="button"
                          onMouseDown={() => {
                            setForm(prev => ({ ...prev, accountId: account.id }))
                            setAccountOpen(false)
                            setAccountSearch('')
                          }}
                          className={cn('w-full px-3 py-1.5 text-left text-sm hover:bg-accent/50 transition-colors', form.accountId === account.id && 'bg-primary/10 font-medium')}
                        >
                          {account.code} - {account.label}
                        </button>
                      ))}
                      {filteredAccounts.length === 0 && (
                        <p className="px-3 py-2 text-sm text-muted-foreground">No accounts found.</p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 items-start">
                <div className="space-y-1">
                  <Label htmlFor="ef-amount">Amount inc. GST ($) *</Label>
                  <Input id="ef-amount" type="number" step="0.01" min="0" value={form.amountIncGst} onChange={e => setForm(f => ({ ...f, amountIncGst: e.target.value }))} placeholder="0.00" disabled={isFinancialLocked} />
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

              {!isNew && expense && (
                <div className="space-y-1 text-sm text-muted-foreground">
                  <div>Ex-GST: <span className="font-medium text-foreground">${fmtAud(expense.amountExGst)}</span></div>
                  <div>GST: <span className="font-medium text-foreground">${fmtAud(expense.gstAmount)}</span></div>
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="ef-notes">Notes</Label>
                <Textarea id="ef-notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" rows={2} />
              </div>

              {expense?.bankTransactionId && (
                <div className="space-y-2">
                  <Label>Linked Bank Transaction</Label>
                  <button
                    type="button"
                    onClick={() => setLinkedTransactionId(expense.bankTransactionId)}
                    className="block text-left text-sm text-primary hover:underline underline-offset-2"
                  >
                    View linked bank transaction
                  </button>
                  {(loadingLinkedTransactionAttachments || linkedTransactionAttachments.length > 0) && (
                    <div className="space-y-2">
                      {loadingLinkedTransactionAttachments ? (
                        <p className="text-xs text-muted-foreground">Loading linked transaction attachments...</p>
                      ) : (
                        <>
                          <AttachmentsPanel
                            items={linkedTransactionAttachments.map((a: AccountingAttachment) => ({ id: a.id, name: a.originalName }) satisfies AttachmentItem)}
                            label={null}
                            onDownload={async (item: AttachmentItem) => {
                              await downloadAccountingAttachment(item.id, item.name)
                            }}
                          />
                          {linkedTransactionAttachments.length > 0 && (
                            <p className="text-xs text-muted-foreground">Read-only. Manage these from the linked bank transaction.</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label>Attachments</Label>
                {expenseId ? (
                  <AttachmentsPanel
                    items={(expense?.attachments ?? []).map((a: AccountingAttachment) => ({ id: a.id, name: a.originalName }) satisfies AttachmentItem)}
                    canUpload
                    uploading={uploadingAttachmentId !== null}
                    deletingId={deletingAttachmentId ?? undefined}
                    label={null}
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
                    {receiptFiles.length > 0 && (
                      <div className="flex flex-col gap-0.5">
                        {receiptFiles.map((f, i) => (
                          <div key={i} className="flex items-center gap-1 text-xs text-white">
                            <Paperclip className="w-3 h-3 shrink-0" />
                            <span className="truncate max-w-[200px]">{f.name}</span>
                            <button type="button" onClick={() => setReceiptFiles(prev => prev.filter((_, j) => j !== i))} className="text-white/60 hover:text-destructive ml-1" aria-label="Remove file">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <NewExpenseDropZone onFiles={files => setReceiptFiles(prev => [...prev, ...files])} />
                  </div>
                )}
              </div>

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

      <LinkedBankTransactionDialog
        open={!!linkedTransactionId}
        transactionId={linkedTransactionId}
        onOpenChange={open => { if (!open) setLinkedTransactionId(null) }}
      />
    </>
  )
}
