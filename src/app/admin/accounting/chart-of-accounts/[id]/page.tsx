'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api-client'
import { ArrowLeft, ArrowUp, ArrowDown, Eye, Loader2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Trash2, Plus, Pencil } from 'lucide-react'
import type { Account, AccountTaxCode, Expense, BankTransaction, JournalEntry } from '@/lib/accounting/types'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'
import { cn, formatDate } from '@/lib/utils'
import { AccountingTableActionButton } from '@/components/admin/accounting/AccountingTableActionButton'
import { ExportMenu, downloadCsv, generateReportPdf } from '@/components/admin/accounting/ExportMenu'
import { DateRangePreset, getThisFinancialYearDates } from '@/components/admin/accounting/DateRangePreset'
import { ExpenseFormModal } from '@/components/admin/accounting/ExpenseFormModal'
import { LinkedBankTransactionDialog } from '@/components/admin/accounting/LinkedBankTransactionDialog'

type SplitEntry = { id: string; bankTransactionId: string; description: string; amountCents: number; taxCode: AccountTaxCode; accountName: string; accountCode: string; bankTransactionDate: string; bankTransactionDescription: string; bankTransactionReference: string | null }
type BankAccountTxnEntry = { id: string; description: string; reference: string | null; amountCents: number; status: string; matchType: string | null }
type SalesInvoiceEntry = {
  id: string
  invoiceId: string
  invoiceNumber: string
  description: string
  amountCents: number
  clientName: string | null
  labelName: string | null
  accountName: string
  accountCode: string
  linkedBankTransactions: { id: string; date: string; description: string; amountCents: number }[]
}

type Entry =
  | { kind: 'expense'; date: string; entry: Expense }
  | { kind: 'bankTransaction'; date: string; entry: BankTransaction }
  | { kind: 'journal'; date: string; entry: JournalEntry }
  | { kind: 'salesInvoice'; date: string; entry: SalesInvoiceEntry }
  | { kind: 'split'; date: string; entry: SplitEntry }
  | { kind: 'bankAccountTxn'; date: string; entry: BankAccountTxnEntry }

function fmtAud(cents: number) {
  const abs = Math.abs(cents)
  return (cents < 0 ? '-' : '') + '$' + (abs / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function getDefaultJournalDate() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isDebitNormalAccountType(accountType: Account['type'] | undefined) {
  return accountType === 'ASSET' || accountType === 'EXPENSE' || accountType === 'COGS'
}

function getEntryAmountExGst(row: Entry, accountType: Account['type'] | undefined, taxRatePercent: number) {
  if (row.kind === 'expense') return (row.entry as Expense).amountExGst
  if (row.kind === 'bankTransaction') {
    const t = row.entry as BankTransaction
    const exGst = amountExcludingGst(t.amountCents, t.taxCode, taxRatePercent)
    return isDebitNormalAccountType(accountType) ? -exGst : exGst
  }
  if (row.kind === 'journal') {
    const j = row.entry as JournalEntry
    return amountExcludingGst(j.amountCents, j.taxCode, taxRatePercent)
  }
  if (row.kind === 'salesInvoice') return (row.entry as SalesInvoiceEntry).amountCents
  if (row.kind === 'bankAccountTxn') return (row.entry as BankAccountTxnEntry).amountCents

  const s = row.entry as SplitEntry
  const exGst = amountExcludingGst(s.amountCents, s.taxCode, taxRatePercent)
  return isDebitNormalAccountType(accountType) ? -exGst : exGst
}

export default function AccountLedgerPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id ?? ''
  const router = useRouter()
  const searchParams = useSearchParams()

  const [account, setAccount] = useState<Account | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [total, setTotal] = useState(0)
  const [periodTotalCents, setPeriodTotalCents] = useState(0)
  const [taxRatePercent, setTaxRatePercent] = useState(10)
  const [hasChildAccounts, setHasChildAccounts] = useState(false)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState(() => searchParams?.get('from') ?? getThisFinancialYearDates().from)
  const [to, setTo] = useState(() => searchParams?.get('to') ?? getThisFinancialYearDates().to)
  const [search, setSearch] = useState('')

  const [editExpenseId, setEditExpenseId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [linkedTransactionId, setLinkedTransactionId] = useState<string | null>(null)
  const [linkedInvoiceTransactions, setLinkedInvoiceTransactions] = useState<SalesInvoiceEntry['linkedBankTransactions']>([])

  type SortKey = 'date' | 'type' | 'account' | 'description' | 'ref' | 'amount'
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function toggleSort(key: SortKey) {
    const newDir = sortKey === key ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'
    setSortKey(key)
    setSortDir(newDir)
    setPage(1)
  }

  // Sorting is server-side; entries arrive pre-sorted for the current page.
  const sortedEntries = entries

  // Journal entry form
  const [jeOpen, setJeOpen] = useState(false)
  const [editingJournalEntry, setEditingJournalEntry] = useState<JournalEntry | null>(null)
  const [jeDate, setJeDate] = useState(getDefaultJournalDate)
  const [jeDesc, setJeDesc] = useState('')
  const [jeAmount, setJeAmount] = useState('')
  const [jeType, setJeType] = useState<'debit' | 'credit'>('debit')
  const [jeTaxCode, setJeTaxCode] = useState('BAS_EXCLUDED')
  const [jeRef, setJeRef] = useState('')
  const [jeNotes, setJeNotes] = useState('')
  const [jeSaving, setJeSaving] = useState(false)

  const PAGE_SIZE = 50

  const fetchAllEntriesForExport = useCallback(async (): Promise<Entry[]> => {
    const params = new URLSearchParams({ page: '1', pageSize: '100000', download: 'true' })
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    if (search.trim()) params.set('q', search.trim())
    params.set('sortBy', sortKey)
    params.set('sortDir', sortDir)
    const res = await apiFetch(`/api/admin/accounting/accounts/${id}/entries?${params}`)
    if (!res.ok) return []
    const d = await res.json()
    return d.entries ?? []
  }, [id, from, to, search, sortKey, sortDir])

  const load = useCallback(async (p: number, fromDate: string, toDate: string, q: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (fromDate) params.set('from', fromDate)
      if (toDate) params.set('to', toDate)
      if (q.trim()) params.set('q', q.trim())
      params.set('sortBy', sortKey)
      params.set('sortDir', sortDir)
      const res = await apiFetch(`/api/admin/accounting/accounts/${id}/entries?${params}`)
      if (!res.ok) { router.push('/admin/accounting/chart-of-accounts'); return }
      const d = await res.json()
      setAccount(d.account)
      setEntries(d.entries ?? [])
      setTotal(d.total ?? 0)
      setPeriodTotalCents(d.periodTotalCents ?? 0)
      setTaxRatePercent(d.taxRatePercent ?? 10)
      setHasChildAccounts(d.hasChildAccounts ?? false)
      setPageCount(d.pageCount ?? 1)
    } finally {
      setLoading(false)
    }
  }, [id, router, sortKey, sortDir])

  useEffect(() => { void load(1, from, to, search) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  function changePage(next: number) {
    setPage(next)
    void load(next, from, to, search)
  }

  async function handleDeleteEntry(target: Entry) {
    setIsDeleting(true)
    try {
      const entryId = target.entry.id
      const res = await apiFetch(
        `/api/admin/accounting/accounts/${id}/entries?entryId=${entryId}&kind=${target.kind}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || 'Failed to delete entry')
        return
      }
      void load(page, from, to, search)
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleCreateJournal() {
    const isEditingJournal = editingJournalEntry !== null
    const cents = Math.round(parseFloat(jeAmount || '0') * 100)
    if (!cents || !jeDesc.trim()) return
    setJeSaving(true)
    try {
      const res = await apiFetch(isEditingJournal ? `/api/admin/accounting/journal-entries/${editingJournalEntry.id}` : '/api/admin/accounting/journal-entries', {
        method: isEditingJournal ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(isEditingJournal ? {} : { accountId: account?.id ?? id }),
          date: jeDate,
          description: jeDesc.trim(),
          amountCents: jeType === 'credit' ? -cents : cents,
          taxCode: jeTaxCode,
          reference: jeRef.trim() || undefined,
          notes: jeNotes.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || (isEditingJournal ? 'Failed to update journal entry' : 'Failed to create journal entry'))
        return
      }
      setJeOpen(false)
      setEditingJournalEntry(null)
      setJeDate(getDefaultJournalDate())
      setJeDesc('')
      setJeAmount('')
      setJeType('debit')
      setJeTaxCode('BAS_EXCLUDED')
      setJeRef('')
      setJeNotes('')
      setPage(1)
      void load(1, from, to, search)
    } finally {
      setJeSaving(false)
    }
  }

  function openNewJournalEntry() {
    setEditingJournalEntry(null)
    setJeDate(getDefaultJournalDate())
    setJeDesc('')
    setJeAmount('')
    setJeType('debit')
    setJeTaxCode(account?.taxCode ?? 'BAS_EXCLUDED')
    setJeRef('')
    setJeNotes('')
    setJeOpen(true)
  }

  function openEditJournalEntry(entry: JournalEntry) {
    setEditingJournalEntry(entry)
    setJeDate(entry.date)
    setJeDesc(entry.description)
    setJeAmount((Math.abs(entry.amountCents) / 100).toFixed(2))
    setJeType(entry.amountCents < 0 ? 'credit' : 'debit')
    setJeTaxCode(entry.taxCode)
    setJeRef(entry.reference ?? '')
    setJeNotes(entry.notes ?? '')
    setJeOpen(true)
  }

  function closeJournalDialog() {
    setJeOpen(false)
    setEditingJournalEntry(null)
  }

  async function openLinkedTransaction(transactionId: string) {
    setLinkedTransactionId(transactionId)
  }

  function openSalesInvoiceLinkedTransactions(transactions: SalesInvoiceEntry['linkedBankTransactions']) {
    if (transactions.length === 1) {
      void openLinkedTransaction(transactions[0].id)
      return
    }
    setLinkedInvoiceTransactions(transactions)
  }

  function closeLinkedInvoiceTransactions() {
    setLinkedInvoiceTransactions([])
  }

  const transactionStatusLabels: Record<string, string> = {
    UNMATCHED: 'Pending',
    MATCHED: 'Posted',
    EXCLUDED: 'Ignored',
  }

  const transactionStatusBadge: Record<string, string> = {
    UNMATCHED: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    MATCHED: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    EXCLUDED: 'bg-muted text-muted-foreground',
  }

  const TYPE_BADGE: Record<string, string> = {
    ASSET: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    LIABILITY: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
    EQUITY: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
    INCOME: 'bg-green-500/15 text-green-700 dark:text-green-400',
    COGS: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
    EXPENSE: 'bg-red-500/15 text-red-700 dark:text-red-400',
  }

  return (
    <div className="px-3 sm:px-4 lg:px-6 py-3 sm:py-6 space-y-4 max-w-screen-2xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/admin/accounting/chart-of-accounts">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="w-4 h-4" />Chart of Accounts
          </Button>
        </Link>
      </div>

      {account && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{account.name}</h1>
            <span className="font-mono text-sm text-muted-foreground bg-muted px-2 py-0.5 rounded">{account.code}</span>
            <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', TYPE_BADGE[account.type] ?? 'bg-muted')}>{account.type}</span>
            {!account.isActive && <span className="text-xs text-muted-foreground border border-border px-2 py-0.5 rounded-full">Inactive</span>}
            {hasChildAccounts && <span className="text-xs text-muted-foreground border border-border px-2 py-0.5 rounded-full">Includes sub-accounts</span>}
          </div>
          <div className="flex items-center gap-2">
            <ExportMenu
              onExportCsv={async () => {
                const all = await fetchAllEntriesForExport()
                downloadCsv(`${account?.code ?? 'account'}-entries.csv`, ['Date', 'Type', 'Account', 'Description', 'Ref', 'Amount'], all.map(row => {
                  const amount = (getEntryAmountExGst(row, account?.type, taxRatePercent) / 100).toFixed(2)
                  if (row.kind === 'expense') { const e = row.entry as Expense; return [e.date, 'Expense', e.accountName ?? account?.name ?? '', e.description, e.supplierName ?? '', amount] }
                  if (row.kind === 'bankTransaction') { const t = row.entry as BankTransaction; return [t.date, 'Bank Txn', t.accountName ?? account?.name ?? '', t.description, t.reference ?? '', amount] }
                  if (row.kind === 'journal') { const j = row.entry as JournalEntry; return [j.date, 'Journal', j.accountName ?? account?.name ?? '', j.description, j.reference ?? '', amount] }
                  if (row.kind === 'salesInvoice') { const s = row.entry as SalesInvoiceEntry; return [row.date, 'Sales Invoice', s.accountName, `${s.invoiceNumber} - ${s.description}`, s.clientName ?? '', amount] }
                  if (row.kind === 'bankAccountTxn') { const t = row.entry as BankAccountTxnEntry; return [row.date, 'Cash', account?.name ?? '', t.description, t.reference ?? '', amount] }
                  const s = row.entry as SplitEntry; return [s.bankTransactionDate, 'Split', s.accountName, s.description || s.bankTransactionDescription, s.bankTransactionReference ?? '', amount]
                }))
              }}
              onExportPdf={async () => {
                const all = await fetchAllEntriesForExport()
                const fmtAudLocal = (cents: number) => { const abs = Math.abs(cents); return (cents < 0 ? '-' : '') + '$' + (abs / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
                generateReportPdf({
                  title: `${account?.code ?? 'Account'} — ${account?.name ?? 'Entries'}`,
                  subtitle: `${from} to ${to}`,
                  sections: [{
                    columns: [
                      { header: 'Date', nowrap: true },
                      { header: 'Type', nowrap: true },
                      { header: 'Account' },
                      { header: 'Description' },
                      { header: 'Ref / Supplier' },
                      { header: 'Amount (ex-GST)', align: 'right', nowrap: true },
                    ],
                    rows: all.map(row => {
                      const amount = fmtAudLocal(getEntryAmountExGst(row, account?.type, taxRatePercent))
                      if (row.kind === 'expense') { const e = row.entry as Expense; return { cells: [formatDate(e.date), 'Expense', e.accountName ?? account?.name ?? '', e.description, e.supplierName ?? '—', amount] } }
                      if (row.kind === 'bankTransaction') { const t = row.entry as BankTransaction; return { cells: [formatDate(t.date), 'Bank Txn', t.accountName ?? account?.name ?? '', t.description, t.reference ?? '—', amount] } }
                      if (row.kind === 'journal') { const j = row.entry as JournalEntry; return { cells: [formatDate(j.date), 'Journal', j.accountName ?? account?.name ?? '', j.description, j.reference ?? '—', amount] } }
                      if (row.kind === 'salesInvoice') { const s = row.entry as SalesInvoiceEntry; return { cells: [formatDate(row.date), 'Sales Invoice', s.accountName, `${s.invoiceNumber} - ${s.description}`, s.clientName ?? '—', amount] } }
                      if (row.kind === 'bankAccountTxn') { const t = row.entry as BankAccountTxnEntry; return { cells: [formatDate(row.date), 'Cash', account?.name ?? '', t.description, t.reference ?? '—', amount] } }
                      const s = row.entry as SplitEntry; return { cells: [formatDate(s.bankTransactionDate), 'Split', s.accountName, s.description || s.bankTransactionDescription, s.bankTransactionReference ?? '—', amount] }
                    }),
                  }],
                })
              }}
              disabled={entries.length === 0}
            />
            <Button className="gap-1.5" onClick={openNewJournalEntry}>
              <Plus className="w-4 h-4" />Journal Entry
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-1 flex-wrap gap-2">
              <Input
                placeholder="Search description, supplier, reference, amount…"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); void load(1, from, to, e.target.value) }}
                className="h-9 w-full sm:max-w-[320px]"
              />
            </div>
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:ml-auto">
              <DateRangePreset
                from={from}
                to={to}
                onFromChange={v => { setFrom(v); setPage(1); void load(1, v, to, search) }}
                onToChange={v => { setTo(v); setPage(1); void load(1, from, v, search) }}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />Loading...
            </div>
          ) : entries.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No entries found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b border-border">
                    {([
                      { key: 'date', label: 'Date', align: 'left', cls: 'whitespace-nowrap min-w-[100px]' },
                      { key: 'type', label: 'Type', align: 'left', cls: 'whitespace-nowrap min-w-[120px]' },
                      { key: 'account', label: 'Account', align: 'left', cls: 'min-w-[140px]' },
                      { key: 'description', label: 'Description', align: 'left', cls: '' },
                      { key: 'ref', label: 'Ref / Supplier', align: 'left', cls: '' },
                      { key: 'amount', label: 'Amount (ex-GST)', align: 'right', cls: 'w-32 whitespace-nowrap' },
                    ] as { key: SortKey; label: string; align: string; cls: string }[]).map(col => (
                      <th key={col.key} className={`px-4 py-2.5 text-${col.align} font-medium text-muted-foreground ${col.cls}`}>
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                        >
                          {col.label}
                          {sortKey === col.key
                            ? (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
                            : <ArrowDown className="w-3 h-3 opacity-0 group-hover:opacity-40" />}
                        </button>
                      </th>
                    ))}
                    <th className="px-4 py-2.5 w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sortedEntries.map((row, i) => {
                    if (row.kind === 'expense') {
                      const e = row.entry as Expense
                      const isOwn = e.accountId === account?.id
                      return (
                        <tr key={`exp-${e.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(e.date)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-400">Expense</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[160px]" title={e.accountName ?? account?.name}>{!isOwn && e.accountName ? `\u2014 ${e.accountName}` : e.accountName ?? account?.name ?? '\u2014'}</td>
                          <td className="px-4 py-2.5 truncate">{e.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{e.supplierName ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            <button type="button" onClick={() => setEditExpenseId(e.id)} className="tabular-nums hover:underline cursor-pointer">{fmtAud(e.amountExGst)}</button>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {e.bankTransactionId && (
                                <AccountingTableActionButton onClick={() => void openLinkedTransaction(e.bankTransactionId!)} title="View linked bank transaction" aria-label="View linked bank transaction">
                                  <Eye className="w-3.5 h-3.5" />
                                </AccountingTableActionButton>
                              )}
                              {isOwn && (
                                <AccountingTableActionButton destructive onClick={() => { if (!confirm('Delete this expense? This cannot be undone.')) return; void handleDeleteEntry(row) }} title="Delete expense" aria-label="Delete expense">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </AccountingTableActionButton>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    } else if (row.kind === 'bankTransaction') {
                      const t = row.entry as BankTransaction
                      const isOwn = t.accountId === account?.id
                      return (
                        <tr key={`txn-${t.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(t.date)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-400">Bank Txn</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[160px]" title={t.accountName ?? account?.name ?? undefined}>{!isOwn && t.accountName ? `\u2014 ${t.accountName}` : t.accountName ?? account?.name ?? '\u2014'}</td>
                          <td className="px-4 py-2.5 truncate">{t.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{t.reference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(getEntryAmountExGst(row, account?.type, taxRatePercent))}</td>
                          <td className="px-4 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <AccountingTableActionButton onClick={() => void openLinkedTransaction(t.id)} title="View bank transaction" aria-label="View bank transaction">
                                <Eye className="w-3.5 h-3.5" />
                              </AccountingTableActionButton>
                              {isOwn && (
                                <AccountingTableActionButton destructive onClick={() => { if (!confirm('Unpost this bank transaction? This will return it to Pending status and remove any linked expense or invoice payment.')) return; void handleDeleteEntry(row) }} title="Unpost bank transaction" aria-label="Unpost bank transaction">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </AccountingTableActionButton>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    } else if (row.kind === 'journal') {
                      const j = row.entry as JournalEntry
                      const isOwn = j.accountId === account?.id
                      return (
                        <tr key={`je-${j.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(j.date)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-700 dark:text-purple-400">Journal</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[160px]" title={j.accountName ?? account?.name}>{!isOwn && j.accountName ? `\u2014 ${j.accountName}` : j.accountName ?? account?.name ?? '\u2014'}</td>
                          <td className="px-4 py-2.5 truncate">{j.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{j.reference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(getEntryAmountExGst(row, account?.type, taxRatePercent))}</td>
                          <td className="px-4 py-2.5 text-right">
                            {isOwn && (
                              <div className="flex items-center justify-end gap-2">
                                <AccountingTableActionButton onClick={() => openEditJournalEntry(j)} title="Edit journal entry" aria-label="Edit journal entry">
                                  <Pencil className="w-3.5 h-3.5" />
                                </AccountingTableActionButton>
                                <AccountingTableActionButton destructive onClick={() => { if (!confirm('Delete this journal entry? This cannot be undone.')) return; void handleDeleteEntry(row) }} title="Delete journal entry" aria-label="Delete journal entry">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </AccountingTableActionButton>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    } else if (row.kind === 'salesInvoice') {
                      const s = row.entry as SalesInvoiceEntry
                      const isOwnSales = s.accountCode === account?.code
                      return (
                        <tr key={`sales-${s.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(row.date)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-700 dark:text-green-400">Sales Invoice</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[160px]" title={s.accountName}>{!isOwnSales && s.accountName ? `\u2014 ${s.accountName}` : s.accountName || '\u2014'}</td>
                          <td className="px-4 py-2.5 truncate">{s.invoiceNumber} - {s.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{s.labelName ?? s.clientName ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            <Link href={`/admin/sales/invoices/${s.invoiceId}`} className="tabular-nums hover:underline cursor-pointer">{fmtAud(s.amountCents)}</Link>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {s.linkedBankTransactions.length > 0 && (
                              <AccountingTableActionButton onClick={() => openSalesInvoiceLinkedTransactions(s.linkedBankTransactions)} title="View linked bank transaction" aria-label="View linked bank transaction">
                                <Eye className="w-3.5 h-3.5" />
                              </AccountingTableActionButton>
                            )}
                          </td>
                        </tr>
                      )
                    } else if (row.kind === 'bankAccountTxn') {
                      const t = row.entry as BankAccountTxnEntry
                      return (
                        <tr key={`batxn-${t.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(row.date)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-700 dark:text-sky-400">Cash</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[160px]">{account?.name ?? '—'}</td>
                          <td className="px-4 py-2.5 truncate">{t.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{t.reference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(t.amountCents)}</td>
                          <td className="px-4 py-2.5 text-right">
                            <AccountingTableActionButton onClick={() => void openLinkedTransaction(t.id)} title="View bank transaction" aria-label="View bank transaction">
                              <Eye className="w-3.5 h-3.5" />
                            </AccountingTableActionButton>
                          </td>
                        </tr>
                      )
                    } else {
                      const s = row.entry as SplitEntry
                      const isOwnSplit = s.accountCode === account?.code
                      return (
                        <tr key={`split-${s.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(s.bankTransactionDate)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400">Split</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[160px]" title={s.accountName}>{!isOwnSplit && s.accountName ? `\u2014 ${s.accountName}` : s.accountName || '\u2014'}</td>
                          <td className="px-4 py-2.5 truncate">{s.description || s.bankTransactionDescription}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{s.bankTransactionReference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(getEntryAmountExGst(row, account?.type, taxRatePercent))}</td>
                          <td className="px-4 py-2.5 text-right">
                            <AccountingTableActionButton onClick={() => void openLinkedTransaction(s.bankTransactionId)} title="View linked bank transaction" aria-label="View linked bank transaction">
                              <Eye className="w-3.5 h-3.5" />
                            </AccountingTableActionButton>
                          </td>
                        </tr>
                      )
                    }
                  })}
                </tbody>
                {!loading && entries.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/30">
                      <td colSpan={5} className="px-4 py-2.5 text-right text-sm font-semibold text-foreground">
                        {pageCount > 1 ? 'Period Total ex-GST (all pages)' : 'Period Total (ex-GST)'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-foreground">{fmtAud(periodTotalCents)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

        </CardContent>
      </Card>

      {entries.length > 0 && (
        <div className="flex items-center justify-between text-sm print:hidden">
          <span className="text-muted-foreground">{total} entr{total !== 1 ? 'ies' : 'y'}</span>
          {pageCount > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => changePage(1)}><ChevronsLeft className="w-3.5 h-3.5" /></Button>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => changePage(page - 1)}><ChevronLeft className="w-3.5 h-3.5" /></Button>
              <span className="px-3 text-muted-foreground">Page {page} of {pageCount}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= pageCount} onClick={() => changePage(page + 1)}><ChevronRight className="w-3.5 h-3.5" /></Button>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= pageCount} onClick={() => changePage(pageCount)}><ChevronsRight className="w-3.5 h-3.5" /></Button>
            </div>
          )}
        </div>
      )}

      <LinkedBankTransactionDialog
        open={!!linkedTransactionId}
        transactionId={linkedTransactionId}
        onOpenChange={open => { if (!open) setLinkedTransactionId(null) }}
        onViewExpense={expenseId => setEditExpenseId(expenseId)}
      />

      <Dialog open={linkedInvoiceTransactions.length > 0} onOpenChange={open => { if (!open) closeLinkedInvoiceTransactions() }}>
        <DialogContent className="w-[min(96vw,56rem)] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Linked Bank Transactions</DialogTitle>
          </DialogHeader>
          <div className="overflow-x-auto pb-1">
            <div className="min-w-[640px] space-y-2 pr-1 sm:min-w-0">
              {linkedInvoiceTransactions.map(transaction => (
                <button
                  key={transaction.id}
                  type="button"
                  onClick={() => {
                    closeLinkedInvoiceTransactions()
                    void openLinkedTransaction(transaction.id)
                  }}
                  className="w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-accent/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium whitespace-normal break-words">{transaction.description}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{formatDate(transaction.date)}</p>
                    </div>
                    <p className="text-sm font-medium tabular-nums whitespace-nowrap">{fmtAud(transaction.amountCents)}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeLinkedInvoiceTransactions}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={jeOpen} onOpenChange={open => { if (open) setJeOpen(true) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingJournalEntry ? 'Edit Journal Entry' : 'New Journal Entry'}</DialogTitle>
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
            <Button variant="outline" onClick={closeJournalDialog} disabled={jeSaving}>Cancel</Button>
            <Button onClick={() => void handleCreateJournal()} disabled={jeSaving || !jeDesc.trim() || !jeAmount}>
              {jeSaving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              {editingJournalEntry ? 'Save Changes' : 'Create Entry'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ExpenseFormModal
        open={editExpenseId !== null}
        expenseId={editExpenseId}
        onClose={() => setEditExpenseId(null)}
        onSaved={() => { setEditExpenseId(null); void load(page, from, to, search) }}
        onDeleted={() => { setEditExpenseId(null); void load(page, from, to, search) }}
      />
    </div>
  )
}
