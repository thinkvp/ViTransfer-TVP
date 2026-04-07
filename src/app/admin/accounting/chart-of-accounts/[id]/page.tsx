'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
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
import { ArrowLeft, Loader2, ChevronLeft, ChevronRight, Trash2, Plus } from 'lucide-react'
import type { Account, Expense, BankTransaction, JournalEntry } from '@/lib/accounting/types'
import { cn, formatDate } from '@/lib/utils'
import { ExportMenu, downloadCsv, downloadPdf } from '@/components/admin/accounting/ExportMenu'

type SplitEntry = { id: string; description: string; amountCents: number; taxCode: string; bankTransactionDate: string; bankTransactionDescription: string; bankTransactionReference: string | null }
type SalesInvoiceEntry = { id: string; invoiceId: string; invoiceNumber: string; description: string; amountCents: number; clientName: string | null; labelName: string | null }

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

  const [account, setAccount] = useState<Account | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

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
      setPageCount(d.pageCount ?? 1)
    } finally {
      setLoading(false)
    }
  }, [id, router])

  useEffect(() => { void load(1, from, to) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  function applyFilter() {
    setPage(1)
    void load(1, from, to)
  }

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

  const TYPE_BADGE: Record<string, string> = {
    ASSET: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    LIABILITY: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
    EQUITY: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
    INCOME: 'bg-green-500/15 text-green-700 dark:text-green-400',
    COGS: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
    EXPENSE: 'bg-red-500/15 text-red-700 dark:text-red-400',
  }

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
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
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-8 w-36 mt-1" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-8 w-36 mt-1" />
            </div>
            <Button size="sm" onClick={applyFilter}>Filter</Button>
            {(from || to) && (
              <Button size="sm" variant="ghost" onClick={() => { setFrom(''); setTo(''); setPage(1); void load(1, '', '') }}>
                Clear
              </Button>
            )}
            <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => setJeOpen(true)}>
              <Plus className="w-3.5 h-3.5" />Journal Entry
            </Button>
            <ExportMenu
              onExportCsv={() => {
                downloadCsv(`${account?.code ?? 'account'}-entries.csv`, ['Date', 'Type', 'Description', 'Ref', 'Amount'], entries.map(row => {
                  if (row.kind === 'expense') { const e = row.entry as Expense; return [e.date, 'Expense', e.description, e.supplierName ?? '', (e.amountIncGst / 100).toFixed(2)] }
                  if (row.kind === 'bankTransaction') { const t = row.entry as BankTransaction; return [t.date, 'Bank Txn', t.description, t.reference ?? '', (t.amountCents / 100).toFixed(2)] }
                  if (row.kind === 'journal') { const j = row.entry as JournalEntry; return [j.date, 'Journal', j.description, j.reference ?? '', (j.amountCents / 100).toFixed(2)] }
                  if (row.kind === 'salesInvoice') { const s = row.entry as SalesInvoiceEntry; return [row.date, 'Sales Invoice', `${s.invoiceNumber} - ${s.description}`, s.clientName ?? '', (s.amountCents / 100).toFixed(2)] }
                  const s = row.entry as SplitEntry; return [s.bankTransactionDate, 'Split', s.description || s.bankTransactionDescription, s.bankTransactionReference ?? '', (s.amountCents / 100).toFixed(2)]
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
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground w-28">Date</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground w-28">Type</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Description</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Ref / Supplier</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground w-32">Amount</th>
                    <th className="px-4 py-2.5 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {entries.map((row, i) => {
                    if (row.kind === 'expense') {
                      const e = row.entry as Expense
                      return (
                        <tr key={`exp-${e.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs">{formatDate(e.date)}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-400">Expense</span>
                          </td>
                          <td className="px-4 py-2.5 max-w-xs truncate">{e.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{e.supplierName ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(e.amountIncGst)}</td>
                          <td className="px-4 py-2.5 text-right">
                            <button type="button" onClick={() => setDeleteTarget(row)} className="text-muted-foreground hover:text-destructive transition-colors" title="Delete expense">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      )
                    } else if (row.kind === 'bankTransaction') {
                      const t = row.entry as BankTransaction
                      return (
                        <tr key={`txn-${t.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs">{formatDate(t.date)}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-400">Bank Txn</span>
                          </td>
                          <td className="px-4 py-2.5 max-w-xs truncate">{t.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{t.reference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(t.amountCents)}</td>
                          <td className="px-4 py-2.5 text-right">
                            <button type="button" onClick={() => setDeleteTarget(row)} className="text-muted-foreground hover:text-destructive transition-colors" title="Unpost bank transaction">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      )
                    } else if (row.kind === 'journal') {
                      const j = row.entry as JournalEntry
                      return (
                        <tr key={`je-${j.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs">{formatDate(j.date)}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-700 dark:text-purple-400">Journal</span>
                          </td>
                          <td className="px-4 py-2.5 max-w-xs truncate">{j.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{j.reference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(j.amountCents)}</td>
                          <td className="px-4 py-2.5 text-right">
                            <button type="button" onClick={() => setDeleteTarget(row)} className="text-muted-foreground hover:text-destructive transition-colors" title="Delete journal entry">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      )
                    } else if (row.kind === 'salesInvoice') {
                      const s = row.entry as SalesInvoiceEntry
                      return (
                        <tr key={`sales-${s.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs">{formatDate(row.date)}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-700 dark:text-green-400">Sales Invoice</span>
                          </td>
                          <td className="px-4 py-2.5 max-w-xs truncate">{s.invoiceNumber} - {s.description}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{s.labelName ?? s.clientName ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(s.amountCents)}</td>
                          <td className="px-4 py-2.5" />
                        </tr>
                      )
                    } else {
                      const s = row.entry as SplitEntry
                      return (
                        <tr key={`split-${s.id}-${i}`} className="hover:bg-accent/20 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs">{formatDate(s.bankTransactionDate)}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400">Split</span>
                          </td>
                          <td className="px-4 py-2.5 max-w-xs truncate">{s.description || s.bankTransactionDescription}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs truncate">{s.bankTransactionReference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAud(s.amountCents)}</td>
                          <td className="px-4 py-2.5" />
                        </tr>
                      )
                    }
                  })}
                </tbody>
              </table>
            </div>
          )}

          {pageCount > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => changePage(page - 1)}>
                <ChevronLeft className="w-4 h-4" />Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page} of {pageCount}</span>
              <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => changePage(page + 1)}>
                Next<ChevronRight className="w-4 h-4" />
              </Button>
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
    </div>
  )
}
