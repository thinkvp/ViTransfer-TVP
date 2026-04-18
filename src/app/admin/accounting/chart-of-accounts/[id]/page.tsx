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
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { apiFetch } from '@/lib/api-client'
import { ArrowLeft, ArrowUp, ArrowDown, Eye, Loader2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Trash2, Plus } from 'lucide-react'
import type { Account, Expense, BankTransaction, JournalEntry } from '@/lib/accounting/types'
import { cn, formatDate } from '@/lib/utils'
import { AccountingTableActionButton } from '@/components/admin/accounting/AccountingTableActionButton'
import { ExportMenu, downloadCsv, downloadPdf } from '@/components/admin/accounting/ExportMenu'
import { DateRangePreset, getThisFinancialYearDates } from '@/components/admin/accounting/DateRangePreset'
import { ExpenseFormModal } from '@/components/admin/accounting/ExpenseFormModal'
import { LinkedBankTransactionDialog } from '@/components/admin/accounting/LinkedBankTransactionDialog'

type SplitEntry = { id: string; bankTransactionId: string; description: string; amountCents: number; taxCode: string; accountName: string; accountCode: string; bankTransactionDate: string; bankTransactionDescription: string; bankTransactionReference: string | null }
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

function fmtAud(cents: number) {
  const abs = Math.abs(cents)
  return (cents < 0 ? '-' : '') + '$' + (abs / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
  const [hasChildAccounts, setHasChildAccounts] = useState(false)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState(() => searchParams?.get('from') ?? getThisFinancialYearDates().from)
  const [to, setTo] = useState(() => searchParams?.get('to') ?? getThisFinancialYearDates().to)
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null)
  const [editExpenseId, setEditExpenseId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [linkedTransactionId, setLinkedTransactionId] = useState<string | null>(null)
  const [linkedInvoiceTransactions, setLinkedInvoiceTransactions] = useState<SalesInvoiceEntry['linkedBankTransactions']>([])

  type SortKey = 'date' | 'type' | 'account' | 'description' | 'ref' | 'amount'
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function toggleSort(key: SortKey) {
    setSortKey(prev => {
      if (prev !== key) { setSortDir('asc'); return key }
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
      return prev
    })
  }

  const sortedEntries = useMemo(() => {
    const getAmt = (row: Entry) => {
      if (row.kind === 'expense') return (row.entry as Expense).amountIncGst
      if (row.kind === 'bankTransaction') return (row.entry as BankTransaction).amountCents
      if (row.kind === 'journal') return (row.entry as JournalEntry).amountCents
      if (row.kind === 'salesInvoice') return (row.entry as SalesInvoiceEntry).amountCents
      return (row.entry as SplitEntry).amountCents
    }
    const getAccount = (row: Entry) => {
      if (row.kind === 'expense') return (row.entry as Expense).accountName ?? account?.name ?? ''
      if (row.kind === 'bankTransaction') return (row.entry as BankTransaction).accountName ?? account?.name ?? ''
      if (row.kind === 'journal') return (row.entry as JournalEntry).accountName ?? account?.name ?? ''
      if (row.kind === 'salesInvoice') return (row.entry as SalesInvoiceEntry).accountName
      return (row.entry as SplitEntry).accountName
    }
    const getDesc = (row: Entry) => {
      if (row.kind === 'expense') return (row.entry as Expense).description
      if (row.kind === 'bankTransaction') return (row.entry as BankTransaction).description
      if (row.kind === 'journal') return (row.entry as JournalEntry).description
      if (row.kind === 'salesInvoice') { const s = row.entry as SalesInvoiceEntry; return `${s.invoiceNumber} - ${s.description}` }
      const s = row.entry as SplitEntry; return s.description || s.bankTransactionDescription
    }
    const getRef = (row: Entry) => {
      if (row.kind === 'expense') return (row.entry as Expense).supplierName ?? ''
      if (row.kind === 'bankTransaction') return (row.entry as BankTransaction).reference ?? ''
      if (row.kind === 'journal') return (row.entry as JournalEntry).reference ?? ''
      if (row.kind === 'salesInvoice') { const s = row.entry as SalesInvoiceEntry; return s.labelName ?? s.clientName ?? '' }
      return (row.entry as SplitEntry).bankTransactionReference ?? ''
    }
    return [...entries].sort((a, b) => {
      let r = 0
      switch (sortKey) {
        case 'date': r = a.date.localeCompare(b.date); break
        case 'type': r = a.kind.localeCompare(b.kind); break
        case 'account': r = getAccount(a).localeCompare(getAccount(b)); break
        case 'description': r = getDesc(a).localeCompare(getDesc(b)); break
        case 'ref': r = getRef(a).localeCompare(getRef(b)); break
        case 'amount': r = getAmt(a) - getAmt(b); break
      }
      return sortDir === 'asc' ? r : -r
    })
  }, [entries, sortKey, sortDir, account])

  // Journal entry form
  const [jeOpen, setJeOpen] = useState(false)
  const [jeDate, setJeDate] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })
  const [jeDesc, setJeDesc] = useState('')
  const [jeAmount, setJeAmount] = useState('')
  const [jeType, setJeType] = useState<'debit' | 'credit'>('debit')
  const [jeTaxCode, setJeTaxCode] = useState('BAS_EXCLUDED')
  const [jeRef, setJeRef] = useState('')
  const [jeNotes, setJeNotes] = useState('')
  const [jeSaving, setJeSaving] = useState(false)

  const PAGE_SIZE = 50

  const load = useCallback(async (p: number, fromDate: string, toDate: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (fromDate) params.set('from', fromDate)
      if (toDate) params.set('to', toDate)
      const res = await apiFetch(`/api/admin/accounting/accounts/${id}/entries?${params}`)
      if (!res.ok) { router.push('/admin/accounting/chart-of-accounts'); return }
      const d = await res.json()
      setAccount(d.account)
      setEntries(d.entries ?? [])
      setTotal(d.total ?? 0)
      setPeriodTotalCents(d.periodTotalCents ?? 0)
      setHasChildAccounts(d.hasChildAccounts ?? false)
      setPageCount(d.pageCount ?? 1)
    } finally {
      setLoading(false)
    }
  }, [id, router])

  useEffect(() => { void load(1, from, to) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  function changePage(next: number) {
    setPage(next)
    void load(next, from, to)
  }

  async function handleDeleteEntry() {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      const entryId = deleteTarget.entry.id
      const res = await apiFetch(
        `/api/admin/accounting/accounts/${id}/entries?entryId=${entryId}&kind=${deleteTarget.kind}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || 'Failed to delete entry')
        return
      }
      setDeleteTarget(null)
      void load(page, from, to)
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleCreateJournal() {
    const cents = Math.round(parseFloat(jeAmount || '0') * 100)
    if (!cents || !jeDesc.trim()) return
    setJeSaving(true)
    try {
      const res = await apiFetch('/api/admin/accounting/journal-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: account?.id ?? id,
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
        alert(d.error || 'Failed to create journal entry')
        return
      }
      setJeOpen(false)
      setJeDesc(''); setJeAmount(''); setJeRef(''); setJeNotes('')
      void load(page, from, to)
    } finally {
      setJeSaving(false)
    }
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
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{account.name}</h1>
          <span className="font-mono text-sm text-muted-foreground bg-muted px-2 py-0.5 rounded">{account.code}</span>
          <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', TYPE_BADGE[account.type] ?? 'bg-muted')}>{account.type}</span>
          {!account.isActive && <span className="text-xs text-muted-foreground border border-border px-2 py-0.5 rounded-full">Inactive</span>}
          {hasChildAccounts && <span className="text-xs text-muted-foreground border border-border px-2 py-0.5 rounded-full">Includes sub-accounts</span>}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <DateRangePreset
              from={from}
              to={to}
              onFromChange={v => { setFrom(v); setPage(1); void load(1, v, to) }}
              onToChange={v => { setTo(v); setPage(1); void load(1, from, v) }}
            />
            <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => setJeOpen(true)}>
              <Plus className="w-3.5 h-3.5" />Journal Entry
            </Button>
            <ExportMenu
              onExportCsv={() => {
                downloadCsv(`${account?.code ?? 'account'}-entries.csv`, ['Date', 'Type', 'Account', 'Description', 'Ref', 'Amount'], entries.map(row => {
                  if (row.kind === 'expense') { const e = row.entry as Expense; return [e.date, 'Expense', e.accountName ?? account?.name ?? '', e.description, e.supplierName ?? '', (e.amountExGst / 100).toFixed(2)] }
                  if (row.kind === 'bankTransaction') { const t = row.entry as BankTransaction; return [t.date, 'Bank Txn', t.accountName ?? account?.name ?? '', t.description, t.reference ?? '', (t.amountCents / 100).toFixed(2)] }
                  if (row.kind === 'journal') { const j = row.entry as JournalEntry; return [j.date, 'Journal', j.accountName ?? account?.name ?? '', j.description, j.reference ?? '', (j.amountCents / 100).toFixed(2)] }
                  if (row.kind === 'salesInvoice') { const s = row.entry as SalesInvoiceEntry; return [row.date, 'Sales Invoice', s.accountName, `${s.invoiceNumber} - ${s.description}`, s.clientName ?? '', (s.amountCents / 100).toFixed(2)] }
                  const s = row.entry as SplitEntry; return [s.bankTransactionDate, 'Split', s.accountName, s.description || s.bankTransactionDescription, s.bankTransactionReference ?? '', (s.amountCents / 100).toFixed(2)]
                }))
              }}
              onExportPdf={() => downloadPdf(`${account?.code ?? 'Account'} Entries`)}
              disabled={entries.length === 0}
            />
            <span className="text-sm text-muted-foreground self-end">{total} entr{total !== 1 ? 'ies' : 'y'}</span>
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
                                <AccountingTableActionButton destructive onClick={() => setDeleteTarget(row)} title="Delete expense" aria-label="Delete expense">
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
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(t.amountCents)}</td>
                          <td className="px-4 py-2.5 text-right">
                            {isOwn && (
                              <AccountingTableActionButton destructive onClick={() => setDeleteTarget(row)} title="Unpost bank transaction" aria-label="Unpost bank transaction">
                                <Trash2 className="w-3.5 h-3.5" />
                              </AccountingTableActionButton>
                            )}
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
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(j.amountCents)}</td>
                          <td className="px-4 py-2.5 text-right">
                            {isOwn && (
                              <AccountingTableActionButton destructive onClick={() => setDeleteTarget(row)} title="Delete journal entry" aria-label="Delete journal entry">
                                <Trash2 className="w-3.5 h-3.5" />
                              </AccountingTableActionButton>
                            )}
                          </td>
                        </tr>
                      )
                    } else if (row.kind === 'salesInvoice') {
                      const s = row.entry as SalesInvoiceEntry
                      return (
                        <tr key={`sales-${s.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(row.date)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-700 dark:text-green-400">Sales Invoice</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[160px]" title={s.accountName}>{s.accountName || '—'}</td>
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
                    } else {
                      const s = row.entry as SplitEntry
                      return (
                        <tr key={`split-${s.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(s.bankTransactionDate)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400">Split</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[160px]" title={s.accountName}>{s.accountName || '—'}</td>
                          <td className="px-4 py-2.5 truncate">{s.description || s.bankTransactionDescription}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{s.bankTransactionReference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(s.amountCents)}</td>
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

          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-1 px-4 py-3 border-t border-border">
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => changePage(1)}><ChevronsLeft className="w-3.5 h-3.5" /></Button>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => changePage(page - 1)}><ChevronLeft className="w-3.5 h-3.5" /></Button>
              <span className="text-sm text-muted-foreground px-2">Page {page} of {pageCount}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= pageCount} onClick={() => changePage(page + 1)}><ChevronRight className="w-3.5 h-3.5" /></Button>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= pageCount} onClick={() => changePage(pageCount)}><ChevronsRight className="w-3.5 h-3.5" /></Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open && !isDeleting) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === 'bankTransaction' ? 'Unpost bank transaction?' : deleteTarget?.kind === 'journal' ? 'Delete journal entry?' : 'Delete expense?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === 'bankTransaction'
                ? 'This will unpost the bank transaction and return it to Pending status. Any linked expense or invoice payment will also be removed.'
                : deleteTarget?.kind === 'journal'
                ? 'This will permanently delete this journal entry. This cannot be undone.'
                : 'This will permanently delete this expense record. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDeleteEntry()}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              {deleteTarget?.kind === 'bankTransaction' ? 'Unpost' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      <Dialog open={jeOpen} onOpenChange={open => { if (!open && !jeSaving) setJeOpen(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Journal Entry</DialogTitle>
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
                <Label className="text-xs">Amount ($)</Label>
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
            <Button variant="outline" onClick={() => setJeOpen(false)} disabled={jeSaving}>Cancel</Button>
            <Button onClick={() => void handleCreateJournal()} disabled={jeSaving || !jeDesc.trim() || !jeAmount}>
              {jeSaving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Create Entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ExpenseFormModal
        open={editExpenseId !== null}
        expenseId={editExpenseId}
        onClose={() => setEditExpenseId(null)}
        onSaved={() => { setEditExpenseId(null); void load(page, from, to) }}
        onDeleted={() => { setEditExpenseId(null); void load(page, from, to) }}
      />
    </div>
  )
}
