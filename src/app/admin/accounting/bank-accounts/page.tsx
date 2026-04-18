'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AccountingTableActionButton } from '@/components/admin/accounting/AccountingTableActionButton'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { apiFetch } from '@/lib/api-client'
import { Plus, Upload, ChevronDown, ChevronRight, Landmark, Pencil, Trash2, Paperclip, X, Loader2, EyeOff, RotateCcw, Link2, AlertTriangle, ArrowUp, ArrowDown, ChevronLeft, ChevronsLeft, ChevronsRight, Scissors } from 'lucide-react'
import { AttachmentsPanel, type AttachmentItem } from '@/components/admin/accounting/AttachmentsPanel'
import type { AccountingAttachment } from '@/lib/accounting/types'
import type { BankAccount, BankTransaction } from '@/lib/accounting/types'
import { buildAccountOptions, type AccountOption } from '@/lib/accounting/account-options'
import { DateRangePreset, getThisFinancialYearDates } from '@/components/admin/accounting/DateRangePreset'
import { ExportMenu, downloadCsv, downloadPdf } from '@/components/admin/accounting/ExportMenu'
import { cn, formatDate } from '@/lib/utils'

interface TaxRateOption { id: string; name: string; code: string; rate: number; isDefault: boolean }

interface OpenInvoice {
  id: string
  invoiceNumber: string
  status: string
  issueDate: string
  dueDate: string | null
  clientName: string | null
  projectTitle: string | null
  totalCents: number
  totalPaidCents: number
  outstandingBalanceCents: number
}

type TabKey = 'UNMATCHED' | 'MATCHED' | 'EXCLUDED'

interface PostFormState {
  transactionType: string
  accountId: string
  accountSearch: string
  accountOpen: boolean
  taxCode: string
  memo: string
  supplierName: string
  files: File[]
  suggestedAccountId: string
}

const TYPE_LABELS: Record<string, string> = {
  Deposit: 'Deposit',
  Transfer: 'Transfer',
  ReceivePayment: 'Receive Payment',
  Expense: 'Expense',
}

function txnTypeOptions(amountCents: number): string[] {
  // Credits (money in) → Deposit/ReceivePayment/Transfer; debits (money out) → Expense/Transfer.
  // Xero/QBO convention: you never change the type to Expense for a refund — just pick an expense
  // account with Deposit/Transfer and the debit-normal sign logic reduces the balance correctly.
  return amountCents >= 0 ? ['Deposit', 'ReceivePayment', 'Transfer'] : ['Expense', 'Transfer']
}

function defaultPostForm(txn: BankTransaction, taxRates: TaxRateOption[]): PostFormState {
  const isDebit = txn.amountCents < 0
  const defaultTax = taxRates.find(r => r.isDefault) ?? taxRates.find(r => r.code === 'GST') ?? null
  return {
    transactionType: isDebit ? 'Expense' : 'Deposit',
    accountId: '',
    accountSearch: '',
    accountOpen: false,
    taxCode: defaultTax?.code ?? 'GST',
    memo: '',
    supplierName: '',
    files: [],
    suggestedAccountId: '',
  }
}

function fmtAmt(cents: number) {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cents < 0 ? `-$${abs}` : `$${abs}`
}

function fmtAud(cents: number) {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'UNMATCHED', label: 'Pending' },
  { key: 'MATCHED', label: 'Posted' },
  { key: 'EXCLUDED', label: 'Ignored' },
]

export default function BankAccountsPage() {
  const router = useRouter()
  const PAGE_SIZE = 50

  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BankAccount | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [txnTotal, setTxnTotal] = useState(0)
  const [txnPage, setTxnPage] = useState(1)
  const [loadingTxns, setLoadingTxns] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('UNMATCHED')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [txnFrom, setTxnFrom] = useState(() => getThisFinancialYearDates().from)
  const [txnTo, setTxnTo] = useState(() => getThisFinancialYearDates().to)
  const [txnSortKey, setTxnSortKey] = useState<'date' | 'description' | 'amount'>('date')
  const [txnSortDir, setTxnSortDir] = useState<'asc' | 'desc'>('desc')
  const [txnSearch, setTxnSearch] = useState('')

  const [coaAccounts, setCoaAccounts] = useState<AccountOption[]>([])
  const [taxRates, setTaxRates] = useState<TaxRateOption[]>([])

  const [postForms, setPostForms] = useState<Record<string, PostFormState>>({})
  const [posting, setPosting] = useState<string | null>(null)
  const [undoing, setUndoing] = useState<string | null>(null)
  const [ignoring, setIgnoring] = useState<string | null>(null)
  const [deleteTransactionTarget, setDeleteTransactionTarget] = useState<BankTransaction | null>(null)
  const [deletingTransaction, setDeletingTransaction] = useState(false)
  const [deletingAttachment, setDeletingAttachment] = useState<string | null>(null)
  const [uploadingAttachmentTxnId, setUploadingAttachmentTxnId] = useState<string | null>(null)
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; duplicates: number } | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)
  const [importStep, setImportStep] = useState<'pick' | 'preview' | 'done'>('pick')
  const [importPreviewing, setImportPreviewing] = useState(false)
  type PreviewRow = { index: number; date: string; description: string; reference: string | null; amountCents: number; isDuplicate: boolean }
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([])
  const [selectedImportIndices, setSelectedImportIndices] = useState<Set<number>>(new Set())
  const [previewFormat, setPreviewFormat] = useState('')

  // Invoice matching dialog
  const [matchInvoiceTarget, setMatchInvoiceTarget] = useState<BankTransaction | null>(null)
  const [invoiceSearch, setInvoiceSearch] = useState('')
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([])
  const [loadingInvoices, setLoadingInvoices] = useState(false)
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null)
  const [matchingInvoice, setMatchingInvoice] = useState(false)

  // Expense matching dialog
  interface UnmatchedExpense { id: string; date: string; supplierName: string | null; description: string; accountName: string; accountCode: string; taxCode: string; amountIncGstCents: number; status: string }
  const [matchExpenseTarget, setMatchExpenseTarget] = useState<BankTransaction | null>(null)
  const [expenseSearch, setExpenseSearch] = useState('')
  const [unmatchedExpenses, setUnmatchedExpenses] = useState<UnmatchedExpense[]>([])
  const [loadingExpenses, setLoadingExpenses] = useState(false)
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null)
  const [matchingExpense, setMatchingExpense] = useState(false)

  // Split transaction state
  const [splitTxnId, setSplitTxnId] = useState<string | null>(null)

  // Quick-match: eagerly loaded matches for pending transactions
  const [quickMatchInvoices, setQuickMatchInvoices] = useState<OpenInvoice[]>([])
  const [quickMatchExpenses, setQuickMatchExpenses] = useState<UnmatchedExpense[]>([])
  const [quickMatching, setQuickMatching] = useState<string | null>(null)
  type SplitFormLine = { accountId: string; accountSearch: string; accountOpen: boolean; description: string; amountCents: string; taxCode: string }
  const emptySplitLine = (): SplitFormLine => ({ accountId: '', accountSearch: '', accountOpen: false, description: '', amountCents: '', taxCode: 'BAS_EXCLUDED' })
  const [splitLines, setSplitLines] = useState<SplitFormLine[]>([emptySplitLine(), emptySplitLine()])
  const [splitting, setSplitting] = useState(false)

  const selectedAccount = accounts.find(a => a.id === selectedAccountId) ?? null
  const txnPageCount = Math.max(1, Math.ceil(txnTotal / PAGE_SIZE))

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true)
    try {
      const res = await apiFetch('/api/admin/accounting/bank-accounts')
      if (res.ok) {
        const d = await res.json()
        const accts: BankAccount[] = d.bankAccounts ?? []
        setAccounts(accts)
        // Auto-select first account on initial load
        setSelectedAccountId(prev => prev ?? (accts.length > 0 ? accts[0].id : null))
      }
    } finally { setLoadingAccounts(false) }
  }, [])

  const loadTransactions = useCallback(async (accountId: string, tab: TabKey, page: number) => {
    setLoadingTxns(true)
    setExpandedId(null)
    setPostForms({})
    try {
      const params = new URLSearchParams({ bankAccountId: accountId, status: tab, page: String(page), pageSize: String(PAGE_SIZE), sortKey: txnSortKey, sortDir: txnSortDir })
      if (txnFrom) params.set('from', txnFrom)
      if (txnTo) params.set('to', txnTo)
      if (txnSearch.trim()) params.set('search', txnSearch.trim())
      const res = await apiFetch(`/api/admin/accounting/transactions?${params}`)
      if (res.ok) { const d = await res.json(); setTransactions(d.transactions ?? []); setTxnTotal(d.pagination?.total ?? 0) }
    } finally { setLoadingTxns(false) }
  }, [txnFrom, txnTo, txnSortKey, txnSortDir, txnSearch])

  const sortedTransactions = transactions

  function toggleTxnSort(key: 'date' | 'description' | 'amount') {
    setTxnPage(1)
    setTxnSortKey(prev => {
      if (prev !== key) { setTxnSortDir('desc'); return key }
      setTxnSortDir(d => d === 'asc' ? 'desc' : 'asc')
      return prev
    })
  }

  const loadRefData = useCallback(async () => {
    const [coaRes, trRes] = await Promise.all([
      apiFetch('/api/admin/accounting/accounts?activeOnly=true'),
      apiFetch('/api/admin/accounting/tax-rates'),
    ])
    if (coaRes.ok) { const d = await coaRes.json(); setCoaAccounts(buildAccountOptions(d.accounts ?? [])) }
    if (trRes.ok) { const d = await trRes.json(); setTaxRates(d.taxRates ?? []) }
  }, [])

  useEffect(() => { void loadAccounts() }, [loadAccounts])
  useEffect(() => { void loadRefData() }, [loadRefData])
  useEffect(() => {
    if (selectedAccountId) void loadTransactions(selectedAccountId, activeTab, txnPage)
  }, [selectedAccountId, activeTab, txnPage, loadTransactions])

  // Eagerly load open invoices + unmatched expenses for quick-match badges on the Pending tab
  useEffect(() => {
    if (activeTab !== 'UNMATCHED') { setQuickMatchInvoices([]); setQuickMatchExpenses([]); return }
    apiFetch('/api/admin/accounting/open-invoices').then(r => r.ok ? r.json() : null).then(d => { if (d?.invoices) setQuickMatchInvoices(d.invoices) }).catch(() => {})
    apiFetch('/api/admin/accounting/unmatched-expenses').then(r => r.ok ? r.json() : null).then(d => { if (d?.expenses) setQuickMatchExpenses(d.expenses) }).catch(() => {})
  }, [activeTab])

  async function handleQuickMatchInvoice(txn: BankTransaction, invoiceId: string) {
    setQuickMatching(txn.id)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${txn.id}/match-invoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to match invoice'); return }
      setTransactions(prev => prev.filter(t => t.id !== txn.id))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === txn.id ? null : prev)
      apiFetch('/api/admin/accounting/open-invoices').then(r => r.ok ? r.json() : null).then(d => { if (d?.invoices) setQuickMatchInvoices(d.invoices) }).catch(() => {})
    } finally { setQuickMatching(null) }
  }

  async function handleQuickMatchExpense(txn: BankTransaction, expenseId: string) {
    setQuickMatching(txn.id)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${txn.id}/match`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchType: 'EXPENSE', expenseId }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to match expense'); return }
      setTransactions(prev => prev.filter(t => t.id !== txn.id))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === txn.id ? null : prev)
      apiFetch('/api/admin/accounting/unmatched-expenses').then(r => r.ok ? r.json() : null).then(d => { if (d?.expenses) setQuickMatchExpenses(d.expenses) }).catch(() => {})
    } finally { setQuickMatching(null) }
  }

  function handleSelectAccount(a: BankAccount) {
    setSelectedAccountId(a.id)
    setActiveTab('UNMATCHED')
    setTxnPage(1)
  }

  function handleTabChange(tab: TabKey) { setActiveTab(tab); setTxnPage(1); setTxnSearch('') }

  function getPostForm(txn: BankTransaction): PostFormState {
    return postForms[txn.id] ?? defaultPostForm(txn, taxRates)
  }

  function setPostFormField(txnId: string, updates: Partial<PostFormState>) {
    setPostForms(prev => ({ ...prev, [txnId]: { ...(prev[txnId] ?? {}), ...updates } as PostFormState }))
  }

  function handleRowClick(txn: BankTransaction) {
    const next = expandedId === txn.id ? null : txn.id
    setExpandedId(next)
    if (next && !postForms[txn.id]) {
      const initial = defaultPostForm(txn, taxRates)
      setPostForms(prev => ({ ...prev, [txn.id]: initial }))
      // Fetch account suggestion for this description
      if (selectedAccountId && txn.status === 'UNMATCHED') {
        const params = new URLSearchParams({ bankAccountId: selectedAccountId, description: txn.description ?? '' })
        apiFetch(`/api/admin/accounting/transactions/suggest-account?${params}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (d?.accountId) {
              setPostForms(prev => {
                const current = prev[txn.id] ?? initial
                // Only apply suggestion if user hasn't already picked an account
                if (current.accountId) return prev
                const suggestedTaxCode = coaAccounts.find(a => a.id === d.accountId)?.taxCode
                return { ...prev, [txn.id]: { ...current, accountId: d.accountId, suggestedAccountId: d.accountId, ...(suggestedTaxCode ? { taxCode: suggestedTaxCode } : {}) } }
              })
            }
          })
          .catch(() => {/* ignore suggestion errors */})
      }
    }
  }

  async function handlePost(txn: BankTransaction) {
    const form = getPostForm(txn)
    if (!form.accountId) { alert('Please select an account'); return }
    setPosting(txn.id)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${txn.id}/post`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionType: form.transactionType, accountId: form.accountId, taxCode: form.taxCode, memo: form.memo || null, supplierName: form.supplierName || null }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to post'); return }
      let attachmentUploadError: string | null = null
      if (form.files.length > 0) {
        for (const file of form.files) {
          const fd = new FormData()
          fd.append('file', file)
          const uploadRes = await apiFetch(`/api/admin/accounting/transactions/${txn.id}/attachments`, { method: 'POST', body: fd })
          if (!uploadRes.ok) {
            const d = await uploadRes.json().catch(() => ({}))
            attachmentUploadError = d.error || `Failed to upload attachment "${file.name}"`
            break
          }
        }
      }
      if (attachmentUploadError) alert(`Transaction posted, but attachment upload failed: ${attachmentUploadError}`)
      // Remove from list without full reload so the page scroll position is preserved
      setTransactions(prev => prev.filter(t => t.id !== txn.id))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === txn.id ? null : prev)
      setPostForms(prev => { const next = { ...prev }; delete next[txn.id]; return next })
    } finally { setPosting(null) }
  }

  async function handleIgnore(txnId: string) {
    setIgnoring(txnId)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${txnId}/exclude`, { method: 'POST' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to ignore'); return }
      setTransactions(prev => prev.filter(t => t.id !== txnId))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === txnId ? null : prev)
      setPostForms(prev => { const next = { ...prev }; delete next[txnId]; return next })
    } finally { setIgnoring(null) }
  }

  async function handleUndo(txnId: string) {
    setUndoing(txnId)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${txnId}/unmatch`, { method: 'POST' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to undo'); return }
      setTransactions(prev => prev.filter(t => t.id !== txnId))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === txnId ? null : prev)
      void loadAccounts()
    } finally { setUndoing(null) }
  }

  function openSplitForm(txn: BankTransaction) {
    setSplitTxnId(txn.id)
    setSplitLines([emptySplitLine(), emptySplitLine()])
  }

  function updateSplitLine(idx: number, patch: Partial<SplitFormLine>) {
    setSplitLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l))
  }

  function addSplitLine() {
    setSplitLines(prev => [...prev, emptySplitLine()])
  }

  function removeSplitLine(idx: number) {
    setSplitLines(prev => prev.filter((_, i) => i !== idx))
  }

  async function handleSplit(txn: BankTransaction) {
    const lines = splitLines.map(l => ({
      accountId: l.accountId,
      description: l.description,
      amountCents: Math.round(parseFloat(l.amountCents || '0') * 100) * (txn.amountCents < 0 ? -1 : 1),
      taxCode: l.taxCode,
    }))
    if (lines.some(l => !l.accountId)) { alert('All split lines must have an account'); return }
    if (lines.some(l => l.amountCents === 0)) { alert('All split lines must have a non-zero amount'); return }
    setSplitting(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${txn.id}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to split'); return }
      setSplitTxnId(null)
      setTransactions(prev => prev.filter(t => t.id !== txn.id))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === txn.id ? null : prev)
    } finally { setSplitting(false) }
  }

  async function downloadAccountingAttachment(attachmentId: string, filename: string) {
    try {
      const res = await apiFetch(`/api/admin/accounting/attachments/${attachmentId}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || 'Failed to download attachment')
        return
      }
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

  async function handleDeleteAccountingAttachment(attachmentId: string, txnId: string) {
    if (!confirm('Delete this attachment? This cannot be undone.')) return
    setDeletingAttachment(attachmentId)
    try {
      const res = await apiFetch(`/api/admin/accounting/attachments/${attachmentId}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete attachment'); return }
      setTransactions(prev => prev.map(t => t.id === txnId
        ? { ...t, attachments: (t.attachments ?? []).filter(a => a.id !== attachmentId) }
        : t
      ))
    } finally { setDeletingAttachment(null) }
  }

  async function handleUploadPostedAttachment(txnId: string, files: File[]) {
    setUploadingAttachmentTxnId(txnId)
    try {
      const newAttachments: AccountingAttachment[] = []
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await apiFetch(`/api/admin/accounting/transactions/${txnId}/attachments`, { method: 'POST', body: fd })
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Upload failed'); return }
        const d = await res.json()
        newAttachments.push(...(d.attachments ?? []))
      }
      setTransactions(prev => prev.map(t => t.id === txnId
        ? { ...t, attachments: [...(t.attachments ?? []), ...newAttachments] }
        : t
      ))
    } finally { setUploadingAttachmentTxnId(null) }
  }

  async function handleDeleteAccount() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bank-accounts/${deleteTarget.id}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete'); return }
      if (selectedAccountId === deleteTarget.id) { setSelectedAccountId(null); setTransactions([]) }
      setDeleteTarget(null)
      await loadAccounts()
    } finally { setDeleting(false) }
  }

  async function handleDeleteTransaction() {
    if (!deleteTransactionTarget) return
    setDeletingTransaction(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${deleteTransactionTarget.id}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete transaction'); return }
      const txnId = deleteTransactionTarget.id
      setTransactions(prev => prev.filter(t => t.id !== txnId))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === txnId ? null : prev)
      setDeleteTransactionTarget(null)
    } finally { setDeletingTransaction(false) }
  }

  async function handlePreview() {
    if (!importFile || !selectedAccountId) return
    setImportPreviewing(true)
    try {
      const fd = new FormData()
      fd.append('bankAccountId', selectedAccountId)
      fd.append('file', importFile)
      const res = await apiFetch('/api/admin/accounting/transactions/import/preview', { method: 'POST', body: fd })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Preview failed'); return }
      const d = await res.json()
      const rows: PreviewRow[] = d.rows ?? []
      setPreviewRows(rows)
      setPreviewFormat(d.format ?? '')
      setSelectedImportIndices(new Set(rows.filter((r: PreviewRow) => !r.isDuplicate).map((r: PreviewRow) => r.index)))
      setImportStep('preview')
    } finally { setImportPreviewing(false) }
  }

  async function handleImport() {
    if (!importFile || !selectedAccountId) return
    setImporting(true); setImportResult(null)
    try {
      const fd = new FormData()
      fd.append('bankAccountId', selectedAccountId)
      fd.append('file', importFile)
      fd.append('selectedIndices', JSON.stringify([...selectedImportIndices]))
      const res = await apiFetch('/api/admin/accounting/transactions/import', { method: 'POST', body: fd })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Import failed'); return }
      const d = await res.json()
      setImportResult({ imported: d.batch?.rowCount ?? 0, duplicates: d.batch?.skippedCount ?? 0 })
      setImportFile(null)
      setImportStep('done')
      await loadTransactions(selectedAccountId, activeTab, txnPage)
    } finally { setImporting(false) }
  }

  function closeImportDialog() {
    if (importing || importPreviewing) return
    setImportOpen(false)
    setImportFile(null)
    setImportResult(null)
    setImportStep('pick')
    setPreviewRows([])
    setSelectedImportIndices(new Set())
  }

  function openMatchInvoiceDialog(txn: BankTransaction) {
    setMatchInvoiceTarget(txn)
    setSelectedInvoiceId(null)
    setInvoiceSearch('')
    setOpenInvoices([])
    void loadOpenInvoices('')
  }

  const loadOpenInvoices = useCallback(async (q: string) => {
    setLoadingInvoices(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      const res = await apiFetch(`/api/admin/accounting/open-invoices?${params}`)
      if (res.ok) { const d = await res.json(); setOpenInvoices(d.invoices ?? []) }
    } finally { setLoadingInvoices(false) }
  }, [])

  async function handleMatchInvoice() {
    if (!matchInvoiceTarget || !selectedInvoiceId) return
    setMatchingInvoice(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${matchInvoiceTarget.id}/match-invoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: selectedInvoiceId }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to match invoice'); return }
      const matchedId = matchInvoiceTarget.id
      setMatchInvoiceTarget(null)
      setTransactions(prev => prev.filter(t => t.id !== matchedId))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === matchedId ? null : prev)
      apiFetch('/api/admin/accounting/open-invoices').then(r => r.ok ? r.json() : null).then(d => { if (d?.invoices) setQuickMatchInvoices(d.invoices) }).catch(() => {})
    } finally { setMatchingInvoice(false) }
  }

  function openMatchExpenseDialog(txn: BankTransaction) {
    setMatchExpenseTarget(txn)
    setSelectedExpenseId(null)
    setExpenseSearch('')
    setUnmatchedExpenses([])
    void loadUnmatchedExpenses('')
  }

  const loadUnmatchedExpenses = useCallback(async (q: string) => {
    setLoadingExpenses(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      const res = await apiFetch(`/api/admin/accounting/unmatched-expenses?${params}`)
      if (res.ok) { const d = await res.json(); setUnmatchedExpenses(d.expenses ?? []) }
    } finally { setLoadingExpenses(false) }
  }, [])

  async function handleMatchExpense() {
    if (!matchExpenseTarget || !selectedExpenseId) return
    setMatchingExpense(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/transactions/${matchExpenseTarget.id}/match`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchType: 'EXPENSE', expenseId: selectedExpenseId }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to match expense'); return }
      const matchedId = matchExpenseTarget.id
      setMatchExpenseTarget(null)
      setTransactions(prev => prev.filter(t => t.id !== matchedId))
      setTxnTotal(prev => Math.max(0, prev - 1))
      setExpandedId(prev => prev === matchedId ? null : prev)
      apiFetch('/api/admin/accounting/unmatched-expenses').then(r => r.ok ? r.json() : null).then(d => { if (d?.expenses) setQuickMatchExpenses(d.expenses) }).catch(() => {})
    } finally { setMatchingExpense(false) }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Bank Account Cards */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold">Bank Accounts</h2>
            <p className="text-sm text-muted-foreground">Select an account to view and post transactions.</p>
          </div>
          <Button size="sm" onClick={() => router.push('/admin/accounting/bank-accounts/new')}>
            <Plus className="w-4 h-4 mr-1.5" />New Account
          </Button>
        </div>

        {loadingAccounts ? (
          <div className="py-8 text-center text-muted-foreground text-sm">Loading accounts…</div>
        ) : accounts.length === 0 ? (
          <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">No bank accounts yet. Add one to get started.</CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {accounts.map(a => (
              <button
                key={a.id}
                onClick={() => handleSelectAccount(a)}
                className={cn(
                  'text-left rounded-lg border px-4 py-3 hover:bg-accent/40 transition-colors w-full',
                  selectedAccountId === a.id ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-border bg-card'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Landmark className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    <p className="font-medium text-sm truncate">{a.name}</p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <span
                      role="button" tabIndex={0}
                      onClick={e => { e.stopPropagation(); router.push(`/admin/accounting/bank-accounts/${a.id}`) }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); router.push(`/admin/accounting/bank-accounts/${a.id}`) } }}
                      className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={`Edit ${a.name}`}
                    ><Pencil className="w-3.5 h-3.5" /></span>
                    <span
                      role="button" tabIndex={0}
                      onClick={e => { e.stopPropagation(); setDeleteTarget(a) }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); setDeleteTarget(a) } }}
                      className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={`Delete ${a.name}`}
                    ><Trash2 className="w-3.5 h-3.5" /></span>
                  </div>
                </div>
                {a.bankName && <p className="text-xs text-muted-foreground mt-1 pl-6">{a.bankName}</p>}
                {(a.bsb || a.accountNumber) && <p className="text-xs text-muted-foreground pl-6">{[a.bsb, a.accountNumber].filter(Boolean).join(' / ')}</p>}
                <p className="text-xs text-muted-foreground mt-1 pl-6">{a.currency} · Balance: {fmtAud(a.currentBalance)}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Transactions Section */}
      {selectedAccount && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-xl font-semibold">{selectedAccount.name}</h2>
            <div className="flex items-center gap-2">
              <ExportMenu
                onExportCsv={() => {
                  downloadCsv(`${selectedAccount.name}-transactions.csv`, ['Date', 'Description', 'Reference', 'Type', 'Amount'], transactions.map(t => [
                    t.date, t.description, t.reference ?? '', t.transactionType ?? '', (t.amountCents / 100).toFixed(2),
                  ]))
                }}
                onExportPdf={() => downloadPdf(`${selectedAccount.name} Transactions`)}
                disabled={transactions.length === 0}
              />
              <Button size="sm" variant="outline" onClick={() => { setImportOpen(true); setImportResult(null); setImportFile(null); setImportStep('pick'); setPreviewRows([]); setSelectedImportIndices(new Set()) }}>
                <Upload className="w-4 h-4 mr-1.5" />Import CSV
              </Button>
            </div>
          </div>

          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex gap-0 border-b border-border">
              {TABS.map(tab => (
                <button key={tab.key} onClick={() => handleTabChange(tab.key)}
                className={cn('px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
                  activeTab === tab.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >{tab.label}</button>
            ))}
            </div>
            <Input
              placeholder="Search description, reference…"
              value={txnSearch}
              onChange={e => { setTxnSearch(e.target.value); setTxnPage(1) }}
              className="h-9 w-72 mx-3"
            />
            <DateRangePreset
              from={txnFrom}
              to={txnTo}
              onFromChange={v => { setTxnFrom(v); setTxnPage(1) }}
              onToChange={v => { setTxnTo(v); setTxnPage(1) }}
            />
          </div>

          <Card>
            <CardContent className="p-0">
              {loadingTxns ? (
                <div className="py-10 text-center text-muted-foreground text-sm flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />Loading…
                </div>
              ) : transactions.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground text-sm">
                  No {activeTab === 'UNMATCHED' ? 'pending' : activeTab === 'MATCHED' ? 'posted' : 'ignored'} transactions.
                </div>
              ) : (
                <>
                  <div className="hidden sm:flex items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border text-xs font-medium text-muted-foreground">
                    {activeTab !== 'EXCLUDED' && <div className="w-5 shrink-0" />}
                    <button type="button" onClick={() => toggleTxnSort('date')} className="w-24 shrink-0 flex items-center gap-1 hover:text-foreground transition-colors">
                      Date {txnSortKey === 'date' ? (txnSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : null}
                    </button>
                    <button type="button" onClick={() => toggleTxnSort('description')} className="flex-1 flex items-center gap-1 hover:text-foreground transition-colors">
                      Description {txnSortKey === 'description' ? (txnSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : null}
                    </button>
                    {activeTab === 'MATCHED' && <div className="w-28 shrink-0">Type</div>}
                    {activeTab === 'MATCHED' && <div className="w-32 shrink-0">Account</div>}
                    {activeTab === 'MATCHED' && <div className="w-24 shrink-0">GST</div>}
                    <button type="button" onClick={() => toggleTxnSort('amount')} className="w-28 text-right shrink-0 flex items-center justify-end gap-1 hover:text-foreground transition-colors">
                      {txnSortKey === 'amount' ? (txnSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : null} Amount
                    </button>
                    {activeTab === 'EXCLUDED' && <div className="w-[88px] shrink-0 text-right">Actions</div>}
                  </div>

                  <div className="divide-y divide-border">
                    {sortedTransactions.map(t => {
                      const isExpanded = expandedId === t.id
                      const form = getPostForm(t)
                      const isPosting = posting === t.id
                      const isUndoing = undoing === t.id
                      const isIgnoring = ignoring === t.id
                      const isDeletingTxn = deleteTransactionTarget?.id === t.id && deletingTransaction
                      const types = txnTypeOptions(t.amountCents)
                      const isQuickMatching = quickMatching === t.id

                      // Compute quick-match candidates (only on Pending tab)
                      const quickInvoice = activeTab === 'UNMATCHED' && t.amountCents > 0 ? (() => {
                        const matches = quickMatchInvoices.filter(inv => {
                          return inv.outstandingBalanceCents === t.amountCents
                        })
                        return matches.length === 1 ? matches[0] : null
                      })() : null

                      const quickExpense = activeTab === 'UNMATCHED' && t.amountCents < 0 ? (() => {
                        const abs = Math.abs(t.amountCents)
                        const matches = quickMatchExpenses.filter(exp => exp.amountIncGstCents === abs)
                        return matches.length === 1 ? matches[0] : null
                      })() : null

                      return (
                        <div key={t.id}>
                          <div onClick={() => { if (activeTab !== 'EXCLUDED') handleRowClick(t) }}
                            className={cn('flex items-center gap-2 px-3 py-2.5 hover:bg-muted/40 transition-colors select-none', activeTab !== 'EXCLUDED' && 'cursor-pointer', isExpanded && 'bg-muted/30')}
                          >
                            {activeTab !== 'EXCLUDED' && (
                              <div className="w-5 shrink-0 text-muted-foreground">
                                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                              </div>
                            )}
                            <div className="w-24 shrink-0 text-sm tabular-nums text-muted-foreground whitespace-nowrap">{formatDate(t.date)}</div>
                            {(t.attachments?.length ?? 0) > 0 && <span title="Has attachments" className="shrink-0"><Paperclip className="w-3.5 h-3.5 text-muted-foreground" /></span>}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm truncate">{t.description}</p>
                              {t.reference && <p className="text-xs text-muted-foreground truncate">{t.reference}</p>}
                            </div>
                            {activeTab === 'MATCHED' && (
                              <div className="w-28 shrink-0 hidden sm:block">
                                <span className="text-xs text-muted-foreground">
                                  {t.matchType === 'INVOICE_PAYMENT' ? 'Receive Payment' : t.transactionType ? (TYPE_LABELS[t.transactionType] ?? t.transactionType) : t.expense ? 'Expense' : ''}
                                </span>
                              </div>
                            )}
                            {activeTab === 'MATCHED' && (
                              <div className="w-32 shrink-0 hidden sm:block">
                                {(() => {
                                  if (t.matchType === 'SPLIT') return <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400">Split ({t.splitLines?.length ?? 0})</span>
                                  const acctId = t.accountId ?? t.expense?.accountId
                                  const acctName = t.accountName ?? t.expense?.accountName ?? ''
                                  const acctCode = coaAccounts.find(a => a.id === acctId)?.code
                                  if (acctId && acctCode)
                                    return <Link href={`/admin/accounting/chart-of-accounts/${acctCode}`} onClick={e => e.stopPropagation()} className="text-xs text-primary hover:underline underline-offset-2 truncate block">{acctName}</Link>
                                  if (acctId)
                                    return <Link href={`/admin/accounting/chart-of-accounts/${acctId}`} onClick={e => e.stopPropagation()} className="text-xs text-primary hover:underline underline-offset-2 truncate block">{acctName}</Link>
                                  if (t.matchType === 'INVOICE_PAYMENT') return <span className="text-xs text-muted-foreground truncate block">Matched Invoice</span>
                                  return <span className="text-xs text-muted-foreground truncate block">{acctName}</span>
                                })()}
                              </div>
                            )}
                            {activeTab === 'MATCHED' && (
                              <div className="w-24 shrink-0 hidden sm:block">
                                <span className="text-xs text-muted-foreground">
                                  {t.matchType === 'SPLIT' ? '—' : t.taxCode ? (taxRates.find(r => r.code === t.taxCode)?.name ?? t.taxCode) : '—'}
                                </span>
                              </div>
                            )}
                            {/* Quick-match badge — Pending tab only */}
                            {activeTab === 'UNMATCHED' && quickInvoice && (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); void handleQuickMatchInvoice(t, quickInvoice.id) }}
                                disabled={isQuickMatching}
                                title={`Exact match: Invoice ${quickInvoice.invoiceNumber}${quickInvoice.clientName ? ` — ${quickInvoice.clientName}` : ''}`}
                                className="hidden sm:flex shrink-0 items-center gap-1 text-xs px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors font-medium whitespace-nowrap"
                              >
                                {isQuickMatching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                                {quickInvoice.invoiceNumber}
                              </button>
                            )}
                            {activeTab === 'UNMATCHED' && quickExpense && (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); void handleQuickMatchExpense(t, quickExpense.id) }}
                                disabled={isQuickMatching}
                                title={`Exact match: ${quickExpense.supplierName ? `${quickExpense.supplierName} — ` : ''}${quickExpense.description}`}
                                className="hidden sm:flex shrink-0 items-center gap-1 text-xs px-2 py-1 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 transition-colors font-medium whitespace-nowrap"
                              >
                                {isQuickMatching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                                {quickExpense.supplierName || quickExpense.description.slice(0, 20)}
                              </button>
                            )}
                            <div className={cn('w-28 text-right shrink-0 text-sm tabular-nums font-medium',
                              t.amountCents < 0 ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400')}>
                              {fmtAmt(t.amountCents)}
                            </div>
                            {activeTab === 'EXCLUDED' && (
                              <div className="w-[88px] shrink-0 flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                                <AccountingTableActionButton onClick={() => void handleUndo(t.id)} disabled={isUndoing || isDeletingTxn} title="Undo ignored transaction" aria-label="Undo ignored transaction">
                                  {isUndoing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                </AccountingTableActionButton>
                                <AccountingTableActionButton destructive onClick={() => setDeleteTransactionTarget(t)} disabled={isUndoing || isDeletingTxn} title="Delete ignored transaction" aria-label="Delete ignored transaction">
                                  {isDeletingTxn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 text-destructive" />}
                                </AccountingTableActionButton>
                              </div>
                            )}
                          </div>

                          {isExpanded && activeTab !== 'EXCLUDED' && (
                            <div className="px-4 pt-3 pb-4 bg-muted/10 border-t border-border">
                              <div className="sm:hidden space-y-1 pb-3">
                                <p className="text-xs text-muted-foreground">Description</p>
                                <p className="text-sm leading-5 whitespace-normal break-words">{t.description}</p>
                              </div>
                              {activeTab === 'UNMATCHED' ? (
                                <div className="space-y-3">
                                  <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,140px)_1fr_minmax(0,140px)] gap-3">
                                    <div className="space-y-1">
                                      <div className="h-5 flex items-center"><Label className="text-xs">Type</Label></div>
                                      <Select value={form.transactionType} onValueChange={v => setPostFormField(t.id, { transactionType: v })}>
                                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>{types.map(type => <SelectItem key={type} value={type}>{TYPE_LABELS[type] ?? type}</SelectItem>)}</SelectContent>
                                      </Select>
                                    </div>
                                    <div className="space-y-1">
                                      <div className="h-5 flex items-center justify-between">
                                        <Label className="text-xs">Account</Label>
                                        {form.suggestedAccountId && form.accountId === form.suggestedAccountId && (
                                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 leading-none">SUGGESTED</span>
                                        )}
                                      </div>
                                      <div className="relative">
                                        {(() => {
                                          const filteredAccounts = coaAccounts.filter(a => {
                                            const q = form.accountSearch.trim().toLowerCase()
                                            return !q || a.searchText.includes(q)
                                          })

                                          return (
                                            <>
                                              <Input
                                                className="h-8 text-sm"
                                                placeholder="Search account…"
                                                value={form.accountOpen ? form.accountSearch : (coaAccounts.find(x => x.id === form.accountId)?.label ?? '')}
                                                onFocus={() => setPostFormField(t.id, { accountOpen: true, accountSearch: '' })}
                                                onBlur={() => setTimeout(() => setPostFormField(t.id, { accountOpen: false }), 150)}
                                                onChange={e => setPostFormField(t.id, { accountSearch: e.target.value })}
                                              />
                                              {form.accountOpen && (
                                                <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-52 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                                                  {filteredAccounts.map(a => (
                                                    <button key={a.id} type="button"
                                                      onMouseDown={() => setPostFormField(t.id, { accountId: a.id, accountSearch: '', accountOpen: false, taxCode: a.taxCode })}
                                                      className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors',
                                                        form.accountId === a.id && 'bg-primary/10 font-medium'
                                                      )}
                                                    >{a.label}</button>
                                                  ))}
                                                  {filteredAccounts.length === 0 && (
                                                    <p className="px-3 py-2 text-sm text-muted-foreground">No accounts found.</p>
                                                  )}
                                                </div>
                                              )}
                                            </>
                                          )
                                        })()}
                                      </div>
                                    </div>
                                    <div className="space-y-1">
                                      <div className="h-5 flex items-center"><Label className="text-xs">GST</Label></div>
                                      <Select value={form.taxCode} onValueChange={v => setPostFormField(t.id, { taxCode: v })}>
                                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          {taxRates.length > 0
                                            ? taxRates.map(r => <SelectItem key={r.id} value={r.code}>{r.name}</SelectItem>)
                                            : <>
                                                <SelectItem value="GST">GST (10%)</SelectItem>
                                                <SelectItem value="GST_FREE">GST Free</SelectItem>
                                                <SelectItem value="BAS_EXCLUDED">BAS Excluded</SelectItem>
                                                <SelectItem value="INPUT_TAXED">Input Taxed</SelectItem>
                                              </>}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                      <Label className="text-xs">Memo <span className="text-muted-foreground">(optional)</span></Label>
                                      <Input className="h-8 text-sm" placeholder="Add a note…" value={form.memo} onChange={e => setPostFormField(t.id, { memo: e.target.value })} />
                                    </div>
                                    {form.transactionType === 'Expense' && (
                                      <div className="space-y-1">
                                        <Label className="text-xs">Supplier Name <span className="text-muted-foreground">(optional)</span></Label>
                                        <Input className="h-8 text-sm" placeholder="Supplier name (optional)" value={form.supplierName} onChange={e => setPostFormField(t.id, { supplierName: e.target.value })} />
                                      </div>
                                    )}
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Attachments <span className="text-muted-foreground">(optional)</span></Label>
                                    <input ref={el => { fileRefs.current[t.id] = el }} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple className="hidden" onChange={e => {
                                      const picked = Array.from(e.target.files ?? [])
                                      setPostFormField(t.id, { files: [...(getPostForm(t).files), ...picked] })
                                      if (fileRefs.current[t.id]) fileRefs.current[t.id]!.value = ''
                                    }} />
                                    <div
                                      onClick={() => fileRefs.current[t.id]?.click()}
                                      onDragOver={e => { e.preventDefault(); setDragOverId(t.id) }}
                                      onDragEnter={e => { e.preventDefault(); setDragOverId(t.id) }}
                                      onDragLeave={() => setDragOverId(null)}
                                      onDrop={e => {
                                        e.preventDefault()
                                        setDragOverId(null)
                                        const dropped = Array.from(e.dataTransfer.files)
                                        if (dropped.length > 0) setPostFormField(t.id, { files: [...(getPostForm(t).files), ...dropped] })
                                      }}
                                      className={`flex items-center justify-center gap-1.5 border border-dashed rounded px-3 py-2 cursor-pointer transition-colors text-xs ${
                                        dragOverId === t.id
                                          ? 'border-primary bg-primary/10 text-foreground'
                                          : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                                      }`}
                                    >
                                      <Paperclip className="w-3.5 h-3.5 shrink-0" />
                                      <span>Drop files or click to attach</span>
                                    </div>
                                    {form.files.length > 0 && (
                                      <div className="flex flex-col gap-0.5 mt-1">
                                        {form.files.map((f, fi) => (
                                          <div key={fi} className="flex items-center gap-1 text-xs text-white">
                                            <Paperclip className="w-3 h-3 shrink-0" />
                                            <span className="truncate max-w-[200px]">{f.name}</span>
                                            <button type="button" onClick={() => setPostFormField(t.id, { files: form.files.filter((_, i) => i !== fi) })} className="text-white/60 hover:text-destructive ml-1" aria-label="Remove file">
                                              <X className="w-3 h-3" />
                                            </button>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 pt-1">
                                    <Button size="sm" onClick={() => void handlePost(t)} disabled={isPosting || !form.accountId}>
                                      {isPosting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Post
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => openSplitForm(t)} disabled={isPosting || isIgnoring}>
                                      <Scissors className="w-3.5 h-3.5 mr-1.5" />Split
                                    </Button>
                                    {t.amountCents > 0 && (
                                      <Button size="sm" variant="outline" onClick={() => openMatchInvoiceDialog(t)} disabled={isPosting || isIgnoring}>
                                        <Link2 className="w-3.5 h-3.5 mr-1.5" />Match Invoice
                                      </Button>
                                    )}
                                    {t.amountCents < 0 && (
                                      <Button size="sm" variant="outline" onClick={() => openMatchExpenseDialog(t)} disabled={isPosting || isIgnoring}>
                                        <Link2 className="w-3.5 h-3.5 mr-1.5" />Match Expense
                                      </Button>
                                    )}
                                    <Button size="sm" variant="ghost" onClick={() => void handleIgnore(t.id)} disabled={isIgnoring || isPosting}>
                                      {isIgnoring ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <EyeOff className="w-3.5 h-3.5 mr-1.5" />}Ignore
                                    </Button>
                                  </div>

                                  {/* Split form */}
                                  {splitTxnId === t.id && (
                                    <div className="mt-3 p-3 rounded-lg border border-border bg-muted/20 space-y-3">
                                      <div className="flex items-center justify-between">
                                        <p className="text-sm font-medium">Split Transaction — {fmtAmt(t.amountCents)}</p>
                                        <button type="button" onClick={() => setSplitTxnId(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                                      </div>
                                      {splitLines.map((line, idx) => {
                                        const filteredAccounts = coaAccounts.filter(a => {
                                          const q = line.accountSearch.trim().toLowerCase()
                                          return !q || a.searchText.includes(q)
                                        })
                                        return (
                                          <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_100px_120px_32px] sm:items-end">
                                            <div className="space-y-1">
                                              <Label className="text-xs">Account</Label>
                                              <div className="relative">
                                                <Input
                                                  className="h-8 text-sm"
                                                  placeholder="Search account…"
                                                  value={line.accountOpen ? line.accountSearch : (coaAccounts.find(x => x.id === line.accountId)?.label ?? '')}
                                                  onFocus={() => updateSplitLine(idx, { accountOpen: true, accountSearch: '' })}
                                                  onBlur={() => setTimeout(() => updateSplitLine(idx, { accountOpen: false }), 150)}
                                                  onChange={e => updateSplitLine(idx, { accountSearch: e.target.value })}
                                                />
                                                {line.accountOpen && (
                                                  <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-40 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                                                    {filteredAccounts.map(a => (
                                                      <button key={a.id} type="button"
                                                        onMouseDown={() => updateSplitLine(idx, { accountId: a.id, accountSearch: '', accountOpen: false, taxCode: a.taxCode })}
                                                        className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors', line.accountId === a.id && 'bg-primary/10 font-medium')}
                                                      >{a.label}</button>
                                                    ))}
                                                    {filteredAccounts.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No accounts found.</p>}
                                                  </div>
                                                )}
                                              </div>
                                            </div>
                                            <div className="space-y-1">
                                              <Label className="text-xs">Amount ($)</Label>
                                              <Input type="number" min="0" step="0.01" className="h-8 text-sm" placeholder="0.00"
                                                value={line.amountCents} onChange={e => updateSplitLine(idx, { amountCents: e.target.value })}
                                              />
                                            </div>
                                            <div className="space-y-1">
                                              <Label className="text-xs">GST</Label>
                                              <div className="flex items-center gap-2">
                                                <Select value={line.taxCode} onValueChange={v => updateSplitLine(idx, { taxCode: v })}>
                                                  <SelectTrigger className="h-8 min-w-0 flex-1 text-sm"><SelectValue /></SelectTrigger>
                                                  <SelectContent>
                                                    {taxRates.length > 0
                                                      ? taxRates.map(r => <SelectItem key={r.id} value={r.code}>{r.name}</SelectItem>)
                                                      : <>
                                                          <SelectItem value="GST">GST (10%)</SelectItem>
                                                          <SelectItem value="GST_FREE">GST Free</SelectItem>
                                                          <SelectItem value="BAS_EXCLUDED">BAS Excluded</SelectItem>
                                                          <SelectItem value="INPUT_TAXED">Input Taxed</SelectItem>
                                                        </>}
                                                  </SelectContent>
                                                </Select>
                                                {splitLines.length > 2 && (
                                                  <button type="button" onClick={() => removeSplitLine(idx)} className="h-8 w-8 shrink-0 flex items-center justify-center text-muted-foreground hover:text-destructive sm:hidden"><Trash2 className="w-3.5 h-3.5" /></button>
                                                )}
                                              </div>
                                            </div>
                                            {splitLines.length > 2 && (
                                              <button type="button" onClick={() => removeSplitLine(idx)} className="hidden h-8 items-center justify-center text-muted-foreground hover:text-destructive sm:flex"><Trash2 className="w-3.5 h-3.5" /></button>
                                            )}
                                          </div>
                                        )
                                      })}
                                      {(() => {
                                        const allocated = splitLines.reduce((s, l) => s + Math.round(parseFloat(l.amountCents || '0') * 100), 0)
                                        const total = Math.abs(t.amountCents)
                                        const remaining = total - allocated
                                        return (
                                          <div className="flex items-center justify-between text-xs">
                                            <button type="button" onClick={addSplitLine} className="text-primary hover:underline flex items-center gap-1"><Plus className="w-3 h-3" />Add line</button>
                                            <span className={cn('tabular-nums', remaining === 0 ? 'text-emerald-600' : 'text-destructive')}>
                                              Remaining: {fmtAmt(remaining * (t.amountCents < 0 ? -1 : 1))}
                                            </span>
                                          </div>
                                        )
                                      })()}
                                      <div className="flex gap-2">
                                        <Button size="sm" onClick={() => void handleSplit(t)} disabled={splitting}>
                                          {splitting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Post Split
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => setSplitTxnId(null)}>Cancel</Button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="space-y-3 max-w-xl">
                                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                                    <div className="col-span-2 sm:hidden"><p className="text-xs text-muted-foreground">Description</p><p className="whitespace-normal break-words">{t.description}</p></div>
                                    {(t.transactionType || t.matchType === 'INVOICE_PAYMENT') && <div><p className="text-xs text-muted-foreground">Type</p><p>{t.matchType === 'SPLIT' ? 'Split' : t.matchType === 'INVOICE_PAYMENT' ? 'Receive Payment' : TYPE_LABELS[t.transactionType!] ?? t.transactionType}</p></div>}
                                    {t.matchType !== 'SPLIT' && (() => { const acctId = t.accountId ?? t.expense?.accountId; const name = t.accountName ?? t.expense?.accountName; const code = acctId ? coaAccounts.find(a => a.id === acctId)?.code : undefined; if (t.matchType === 'INVOICE_PAYMENT') return <div><p className="text-xs text-muted-foreground">Posting</p><p>Invoice payment only</p></div>; if (acctId) return <div><p className="text-xs text-muted-foreground">Account</p>{code ? <Link href={`/admin/accounting/chart-of-accounts/${code}`} className="text-sm text-primary hover:underline underline-offset-2">{name}</Link> : <Link href={`/admin/accounting/chart-of-accounts/${acctId}`} className="text-sm text-primary hover:underline underline-offset-2">{name}</Link>}</div>; return null })()}
                                    {t.taxCode && <div><p className="text-xs text-muted-foreground">GST</p><p>{taxRates.find(r => r.code === t.taxCode)?.name ?? t.taxCode}</p></div>}
                                    {t.invoicePayment?.invoiceId && <div className="col-span-2 sm:col-span-3"><p className="text-xs text-muted-foreground">Invoice</p><Link href={`/admin/sales/invoices/${t.invoicePayment.invoiceId}`} className="text-sm text-primary hover:underline underline-offset-2">{t.invoicePayment.invoiceNumber ?? t.invoicePayment.invoiceId}{t.invoicePayment.clientName ? ` — ${t.invoicePayment.clientName}` : ''}</Link></div>}
                                    {t.memo && <div className="col-span-2 sm:col-span-3"><p className="text-xs text-muted-foreground">Memo</p><p>{t.memo}</p></div>}
                                    {t.expense && <div className="col-span-2 sm:col-span-3"><p className="text-xs text-muted-foreground">Expense</p><p>{t.expense.supplierName ? `${t.expense.supplierName} · ` : ''}{fmtAud(t.expense.amountIncGst)}</p></div>}
                                  </div>
                                  {/* Attachments */}
                                  {(() => {
                                    const allItems: AttachmentItem[] = (t.attachments ?? []).map(a => ({ id: a.id, name: a.originalName }))
                                    if (t.status === 'EXCLUDED' && allItems.length === 0) return null
                                    return (
                                      <AttachmentsPanel
                                        items={allItems}
                                        canUpload={t.status === 'MATCHED'}
                                        uploading={uploadingAttachmentTxnId === t.id}
                                        deletingId={deletingAttachment}
                                        onUpload={t.status === 'MATCHED' ? (files => handleUploadPostedAttachment(t.id, files)) : undefined}
                                        onDownload={async item => { await downloadAccountingAttachment(item.id, item.name) }}
                                        onDelete={async item => { await handleDeleteAccountingAttachment(item.id, t.id) }}
                                      />
                                    )
                                  })()}
                                  {t.matchType === 'SPLIT' && t.splitLines && t.splitLines.length > 0 && (
                                    <div className="rounded border border-border overflow-hidden">
                                      <table className="w-full text-xs">
                                        <thead className="bg-muted/30">
                                          <tr>
                                            <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Account</th>
                                            <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Description</th>
                                            <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">GST</th>
                                            <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Amount</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border">
                                          {t.splitLines.map(sl => (
                                            <tr key={sl.id}>
                                              <td className="px-3 py-1.5">
                                                {(() => { const code = sl.accountId ? coaAccounts.find(a => a.id === sl.accountId)?.code : undefined; return sl.accountId ? <Link href={`/admin/accounting/chart-of-accounts/${code ?? sl.accountId}`} className="text-primary hover:underline">{sl.accountName ?? 'Account'}</Link> : (sl.accountName ?? '—') })()}
                                              </td>
                                              <td className="px-3 py-1.5 text-muted-foreground">{sl.description || '—'}</td>
                                              <td className="px-3 py-1.5 text-muted-foreground">{sl.taxCode}</td>
                                              <td className="px-3 py-1.5 text-right tabular-nums">{fmtAud(sl.amountCents)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                  <div className="flex items-center gap-2">
                                    <Button size="sm" variant="outline" onClick={() => void handleUndo(t.id)} disabled={isUndoing || isDeletingTxn}>
                                      {isUndoing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}Undo
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex items-center justify-between px-3 py-2 border-t border-border text-sm">
                    <span className="text-muted-foreground text-xs">{txnTotal} transaction{txnTotal !== 1 ? 's' : ''}</span>
                    {txnPageCount > 1 && (
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={txnPage === 1} onClick={() => setTxnPage(1)}><ChevronsLeft className="w-3.5 h-3.5" /></Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={txnPage === 1} onClick={() => setTxnPage(p => p - 1)}><ChevronLeft className="w-3.5 h-3.5" /></Button>
                        <span className="px-2 text-xs text-muted-foreground">{txnPage} / {txnPageCount}</span>
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={txnPage === txnPageCount} onClick={() => setTxnPage(p => p + 1)}><ChevronRight className="w-3.5 h-3.5" /></Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={txnPage === txnPageCount} onClick={() => setTxnPage(txnPageCount)}><ChevronsRight className="w-3.5 h-3.5" /></Button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Delete Account Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Bank Account?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove &ldquo;{deleteTarget?.name}&rdquo; and all associated transaction data. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteAccount()} disabled={deleting} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">{deleting ? 'Deleting…' : 'Delete'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTransactionTarget} onOpenChange={open => { if (!open && !deletingTransaction) setDeleteTransactionTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete ignored transaction?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>{deleteTransactionTarget?.description}</strong>? This will permanently remove the ignored transaction. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingTransaction}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteTransaction()} disabled={deletingTransaction} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
              {deletingTransaction ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import CSV Dialog */}
      <Dialog open={importOpen} onOpenChange={open => { if (!open) closeImportDialog() }}>
        <DialogContent className={importStep === 'preview' ? 'max-w-3xl' : undefined}>
          <DialogHeader><DialogTitle>Import CSV — {selectedAccount?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {importStep === 'done' && importResult ? (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-4 text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-400">Import complete</p>
                <p className="text-muted-foreground mt-1">{importResult.imported} transaction{importResult.imported !== 1 ? 's' : ''} imported{importResult.duplicates > 0 ? `, ${importResult.duplicates} duplicate${importResult.duplicates !== 1 ? 's' : ''} skipped` : ''}.</p>
              </div>
            ) : importStep === 'preview' ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{previewRows.length} row{previewRows.length !== 1 ? 's' : ''} found{previewFormat ? ` · ${previewFormat}` : ''}</span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelectedImportIndices(new Set(previewRows.map(r => r.index)))}>Select all</Button>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelectedImportIndices(new Set())}>Deselect all</Button>
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto border border-border rounded-md">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-background border-b border-border">
                      <tr>
                        <th className="w-8 px-2 py-1.5"></th>
                        <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Date</th>
                        <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Description</th>
                        <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Amount</th>
                        <th className="w-6"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {previewRows.map(row => (
                        <tr key={row.index} className={row.isDuplicate ? 'opacity-60' : ''}>
                          <td className="px-2 py-1.5 text-center">
                            <input type="checkbox" checked={selectedImportIndices.has(row.index)}
                              onChange={e => {
                                const next = new Set(selectedImportIndices)
                                if (e.target.checked) next.add(row.index); else next.delete(row.index)
                                setSelectedImportIndices(next)
                              }}
                            />
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{row.date}</td>
                          <td className="px-2 py-1.5 max-w-[260px] truncate">{row.description}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{row.amountCents < 0 ? '-' : ''}${(Math.abs(row.amountCents) / 100).toFixed(2)}</td>
                          <td className="px-2 py-1.5">
                            {row.isDuplicate && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" aria-label="Possible duplicate" />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {previewRows.some(r => r.isDuplicate) && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Rows marked with a warning may already exist and are deselected by default.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Upload a bank statement CSV file. Supported: CommBank, NAB, ANZ, Westpac, and generic CSV/OFX formats.</p>
                <div>
                  <Label className="text-sm">CSV File</Label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input ref={importFileRef} type="file" accept=".csv,.ofx,.qif" className="hidden" onChange={e => setImportFile(e.target.files?.[0] ?? null)} />
                    <Button variant="outline" size="sm" onClick={() => importFileRef.current?.click()}>Choose file</Button>
                    {importFile && <span className="text-sm text-muted-foreground truncate max-w-[220px]">{importFile.name}</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeImportDialog}>{importStep === 'done' ? 'Close' : 'Cancel'}</Button>
            {importStep === 'pick' && (
              <Button onClick={() => void handlePreview()} disabled={!importFile || importPreviewing}>
                {importPreviewing && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Preview
              </Button>
            )}
            {importStep === 'preview' && (
              <>
                <Button variant="outline" onClick={() => setImportStep('pick')}>Back</Button>
                <Button onClick={() => void handleImport()} disabled={selectedImportIndices.size === 0 || importing}>
                  {importing && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Import {selectedImportIndices.size} row{selectedImportIndices.size !== 1 ? 's' : ''}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Match Invoice Dialog */}
      <Dialog open={!!matchInvoiceTarget} onOpenChange={open => { if (!open && !matchingInvoice) { setMatchInvoiceTarget(null) } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Match to Invoice — {matchInvoiceTarget ? fmtAmt(matchInvoiceTarget.amountCents) : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Search by invoice number, client, or project..."
              value={invoiceSearch}
              onChange={e => { setInvoiceSearch(e.target.value); void loadOpenInvoices(e.target.value) }}
              className="h-9"
              autoFocus
            />
            {loadingInvoices ? (
              <div className="py-4 text-center text-sm text-muted-foreground flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading...</div>
            ) : openInvoices.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">No open invoices found.</div>
            ) : (
              <div className="max-h-72 overflow-y-auto border border-border rounded-md divide-y divide-border">
                {openInvoices.map(inv => {
                  const total = inv.totalCents
                  const remaining = inv.outstandingBalanceCents
                  const showRemaining = remaining < total
                  return (
                    <button key={inv.id} type="button"
                      onClick={() => setSelectedInvoiceId(inv.id)}
                      className={cn('w-full text-left px-3 py-2.5 hover:bg-accent/40 transition-colors flex items-start justify-between gap-3',
                        selectedInvoiceId === inv.id && 'bg-primary/10 border-l-2 border-primary'
                      )}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{inv.invoiceNumber}</p>
                        <p className="text-xs text-muted-foreground truncate">{[inv.clientName, inv.projectTitle].filter(Boolean).join(' · ')}</p>
                        <p className="text-xs text-muted-foreground">{formatDate(inv.issueDate)}{inv.dueDate ? ` · Due ${formatDate(inv.dueDate)}` : ''}</p>
                      </div>
                      <div className="text-right shrink-0">
                        {showRemaining ? (
                          <>
                            <p className="text-sm font-medium tabular-nums">{fmtAud(remaining)} remaining</p>
                            <p className="text-xs text-muted-foreground tabular-nums">{fmtAud(total)} total</p>
                          </>
                        ) : (
                          <p className="text-sm font-medium tabular-nums">{fmtAud(total)}</p>
                        )}
                        <p className="text-xs text-muted-foreground capitalize">{inv.status.toLowerCase().replace(/_/g, ' ')}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMatchInvoiceTarget(null)} disabled={matchingInvoice}>Cancel</Button>
            <Button onClick={() => void handleMatchInvoice()} disabled={!selectedInvoiceId || matchingInvoice}>
              {matchingInvoice && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Match Invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Match Expense Dialog */}
      <Dialog open={!!matchExpenseTarget} onOpenChange={open => { if (!open && !matchingExpense) { setMatchExpenseTarget(null) } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Match to Expense — {matchExpenseTarget ? fmtAmt(matchExpenseTarget.amountCents) : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Search by supplier, description..."
              value={expenseSearch}
              onChange={e => { setExpenseSearch(e.target.value); void loadUnmatchedExpenses(e.target.value) }}
              className="h-9"
              autoFocus
            />
            {loadingExpenses ? (
              <div className="py-4 text-center text-sm text-muted-foreground flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading...</div>
            ) : unmatchedExpenses.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">No unmatched expenses found.</div>
            ) : (
              <div className="max-h-72 overflow-y-auto border border-border rounded-md divide-y divide-border">
                {unmatchedExpenses.map(exp => (
                  <button key={exp.id} type="button"
                    onClick={() => setSelectedExpenseId(exp.id)}
                    className={cn('w-full text-left px-3 py-2.5 hover:bg-accent/40 transition-colors flex items-start justify-between gap-3',
                      selectedExpenseId === exp.id && 'bg-primary/10 border-l-2 border-primary'
                    )}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{exp.supplierName ? `${exp.supplierName} — ` : ''}{exp.description}</p>
                      <p className="text-xs text-muted-foreground">{exp.accountCode} · {exp.accountName}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(exp.date)} · {exp.taxCode}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-medium tabular-nums">{fmtAud(exp.amountIncGstCents)}</p>
                      <p className="text-xs text-muted-foreground capitalize">{exp.status.toLowerCase()}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMatchExpenseTarget(null)} disabled={matchingExpense}>Cancel</Button>
            <Button onClick={() => void handleMatchExpense()} disabled={!selectedExpenseId || matchingExpense}>
              {matchingExpense && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Match Expense
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
