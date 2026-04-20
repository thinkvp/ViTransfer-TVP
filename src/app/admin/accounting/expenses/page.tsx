'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AccountingTableActionButton } from '@/components/admin/accounting/AccountingTableActionButton'
import { ExpenseFormModal } from '@/components/admin/accounting/ExpenseFormModal'
import { LinkedBankTransactionDialog } from '@/components/admin/accounting/LinkedBankTransactionDialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { DateRangePreset, getThisFinancialYearDates } from '@/components/admin/accounting/DateRangePreset'
import { ExportMenu, downloadCsv, generateReportPdf } from '@/components/admin/accounting/ExportMenu'
import { apiFetch } from '@/lib/api-client'
import { Plus, Pencil, Trash2, Paperclip, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowUp, ArrowDown, Eye } from 'lucide-react'
import type { Expense, ExpenseStatus } from '@/lib/accounting/types'
import { EXPENSE_STATUS_LABELS } from '@/lib/accounting/types'
import { cn, formatDate } from '@/lib/utils'

type SortKey = 'date' | 'supplier' | 'description' | 'category' | 'amountExGst' | 'gstAmount' | 'amountIncGst' | 'status'

const STATUS_BADGE: Record<ExpenseStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  APPROVED: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  RECONCILED: 'bg-green-500/15 text-green-700 dark:text-green-400',
}

function fmtAud(cents: number) {
  return (cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function ExpensesPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [fromDate, setFromDate] = useState(() => getThisFinancialYearDates().from)
  const [toDate, setToDate] = useState(() => getThisFinancialYearDates().to)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 25
  const [exportLoading, setExportLoading] = useState(false)

  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const [modalOpen, setModalOpen] = useState(false)
  const [modalExpenseId, setModalExpenseId] = useState<string | null>(null)
  const [linkedTransactionId, setLinkedTransactionId] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null)
  const [deleting, setDeleting] = useState(false)

  const sortedExpenses = expenses

  // Fetch all expenses (ignoring pagination) for export
  const fetchAllExpensesForExport = useCallback(async (): Promise<Expense[]> => {
    const params = new URLSearchParams({ page: '1', pageSize: '10000', sortKey, sortDir, download: 'true' })
    if (search.trim()) params.set('supplierName', search.trim())
    if (fromDate) params.set('from', fromDate)
    if (toDate) params.set('to', toDate)
    const res = await apiFetch(`/api/admin/accounting/expenses?${params}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.expenses ?? []
  }, [search, fromDate, toDate, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    setPage(1)
    setSortKey(prev => {
      if (prev !== key) { setSortDir('asc'); return key }
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
      return prev
    })
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sortKey, sortDir })
      if (search.trim()) params.set('supplierName', search.trim())
      if (fromDate) params.set('from', fromDate)
      if (toDate) params.set('to', toDate)
      const res = await apiFetch(`/api/admin/accounting/expenses?${params}`)
      if (res.ok) {
        const data = await res.json()
        setExpenses(data.expenses ?? [])
        setTotalPages(data.pagination?.totalPages ?? 1)
        setTotal(data.pagination?.total ?? 0)
      }
    } finally {
      setLoading(false)
    }
  }, [page, search, fromDate, toDate, sortKey, sortDir])

  useEffect(() => { void load() }, [load])

  // Auto-open modal from query params (?new=1 or ?edit=<id>)
  useEffect(() => {
    const editId = searchParams?.get('edit')
    const isNew = searchParams?.get('new') === '1'
    if (editId) {
      setModalExpenseId(editId)
      setModalOpen(true)
    } else if (isNew) {
      setModalExpenseId(null)
      setModalOpen(true)
    }
  }, [searchParams])

  function handleFilterChange(fn: () => void) {
    fn()
    setPage(1)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/expenses/${deleteTarget.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || 'Failed to delete expense')
        return
      }
      setDeleteTarget(null)
      await load()
    } finally {
      setDeleting(false)
    }
  }

  const handleExpenseChanged = useCallback((updatedExpense: Expense) => {
    setExpenses(prev => prev.map(expense => expense.id === updatedExpense.id ? { ...expense, ...updatedExpense } : expense))
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">Expenses</h2>
          <p className="text-sm text-muted-foreground">Track and manage business expenses.</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu
            onExportCsv={async () => {
              setExportLoading(true)
              try {
                const all = await fetchAllExpensesForExport()
                downloadCsv('expenses.csv', ['Date', 'Supplier', 'Description', 'Category', 'Ex GST', 'GST', 'Inc GST', 'Status'], all.map(e => [
                  e.date, e.supplierName ?? '', e.description, e.accountName ?? '', fmtAud(e.amountExGst), fmtAud(e.gstAmount), fmtAud(e.amountIncGst), EXPENSE_STATUS_LABELS[e.status as ExpenseStatus] ?? e.status,
                ]))
              } finally { setExportLoading(false) }
            }}
            onExportPdf={async () => {
              setExportLoading(true)
              try {
                const all = await fetchAllExpensesForExport()
                generateReportPdf({
                  title: 'Expenses',
                  subtitle: [fromDate, toDate].filter(Boolean).join(' to ') || undefined,
                  sections: [{
                    columns: [
                      { header: 'Date', nowrap: true },
                      { header: 'Supplier' },
                      { header: 'Description' },
                      { header: 'Category' },
                      { header: 'Ex GST', align: 'right', nowrap: true },
                      { header: 'GST', align: 'right', nowrap: true },
                      { header: 'Inc GST', align: 'right', nowrap: true },
                      { header: 'Status', nowrap: true },
                    ],
                    rows: all.map(e => ({
                      cells: [formatDate(e.date), e.supplierName ?? '—', e.description, e.accountName ?? '—', '$' + fmtAud(e.amountExGst), '$' + fmtAud(e.gstAmount), '$' + fmtAud(e.amountIncGst), EXPENSE_STATUS_LABELS[e.status as ExpenseStatus] ?? e.status],
                    })),
                  }],
                })
              } finally { setExportLoading(false) }
            }}
            disabled={expenses.length === 0 || exportLoading}
          />
          <Button onClick={() => { setModalExpenseId(null); setModalOpen(true) }}>
            <Plus className="w-4 h-4 mr-1.5" />New Expense
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-1 flex-wrap gap-2">
              <Input
                placeholder="Search supplier, description, amount…"
                value={search}
                onChange={e => handleFilterChange(() => setSearch(e.target.value))}
                className="h-9 w-full sm:max-w-[320px]"
              />
            </div>
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:ml-auto">
              <DateRangePreset
                from={fromDate}
                to={toDate}
                onFromChange={v => handleFilterChange(() => setFromDate(v))}
                onToChange={v => handleFilterChange(() => setToDate(v))}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">Loading…</div>
          ) : expenses.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">No expenses found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b border-border">
                    {([
                      { key: 'date', label: 'Date', align: 'left', cls: 'w-28' },
                      { key: 'supplier', label: 'Supplier', align: 'left', cls: '' },
                      { key: 'description', label: 'Description', align: 'left', cls: '' },
                      { key: 'category', label: 'Category', align: 'left', cls: '' },
                      { key: 'amountExGst', label: 'Ex-GST', align: 'right', cls: 'min-w-[90px]' },
                      { key: 'gstAmount', label: 'GST', align: 'right', cls: 'min-w-[80px]' },
                      { key: 'amountIncGst', label: 'Inc-GST', align: 'right', cls: 'min-w-[90px]' },
                      { key: 'status', label: 'Status', align: 'left', cls: '' },
                    ] as { key: SortKey; label: string; align: string; cls: string }[]).map(col => (
                      <th key={col.key} className={`px-3 py-2 text-${col.align} text-xs font-medium text-muted-foreground ${col.cls}`}>
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                        >
                          {col.label}
                          {sortKey === col.key
                            ? (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
                            : null}
                        </button>
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedExpenses.map(e => (
                    <tr
                      key={e.id}
                      className="border-b border-border last:border-b-0 hover:bg-muted/40 cursor-pointer"
                      onClick={() => { setModalExpenseId(e.id); setModalOpen(true) }}
                    >
                      <td className="px-3 py-2 tabular-nums text-xs text-muted-foreground whitespace-nowrap">{formatDate(e.date)}</td>
                      <td className="px-3 py-2 font-medium">
                        <div className="flex items-center gap-1.5">
                          {e.supplierName ?? <span className="text-muted-foreground italic">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 max-w-[200px]">
                        <div className="flex items-center gap-1.5 truncate">
                          {((e.attachments?.length ?? 0) > 0 || (e.linkedTransactionAttachmentCount ?? 0) > 0) && <span title="Has attachments" className="shrink-0"><Paperclip className="w-3.5 h-3.5 text-muted-foreground" /></span>}
                          <span className="truncate">{e.description}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2" onClick={ev => ev.stopPropagation()}>
                        {e.accountId ? (
                          <Link
                            href={`/admin/accounting/chart-of-accounts/${e.accountCode ?? e.accountId}`}
                            className="text-xs text-primary hover:underline underline-offset-2 whitespace-nowrap"
                          >
                            {e.accountCode ? `${e.accountCode} — ` : ''}{e.accountName ?? 'Account'}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtAud(e.amountExGst)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtAud(e.gstAmount)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAud(e.amountIncGst)}</td>
                      <td className="px-3 py-2">
                        <span className={cn('inline-flex px-2 py-0.5 rounded text-xs font-medium', STATUS_BADGE[e.status])}>
                          {EXPENSE_STATUS_LABELS[e.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right" onClick={ev => ev.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <AccountingTableActionButton onClick={() => { setModalExpenseId(e.id); setModalOpen(true) }} title="Edit expense" aria-label="Edit expense">
                            <Pencil className="w-3.5 h-3.5" />
                          </AccountingTableActionButton>
                          {e.bankTransactionId && (
                            <AccountingTableActionButton onClick={() => setLinkedTransactionId(e.bankTransactionId)} title="View linked bank transaction" aria-label="View linked bank transaction">
                              <Eye className="w-3.5 h-3.5" />
                            </AccountingTableActionButton>
                          )}
                          {e.status !== 'RECONCILED' && !e.bankTransactionId && (
                            <AccountingTableActionButton destructive onClick={() => setDeleteTarget(e)} title="Delete expense" aria-label="Delete expense">
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </AccountingTableActionButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm print:hidden">
          <span className="text-muted-foreground">{total} total</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage(1)}><ChevronsLeft className="w-3.5 h-3.5" /></Button>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft className="w-3.5 h-3.5" /></Button>
            <span className="px-3 text-muted-foreground">Page {page} of {totalPages}</span>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight className="w-3.5 h-3.5" /></Button>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage(totalPages)}><ChevronsRight className="w-3.5 h-3.5" /></Button>
          </div>
        </div>
      )}

      <ExpenseFormModal
        open={modalOpen}
        expenseId={modalExpenseId}
        onClose={() => { setModalOpen(false); router.replace('/admin/accounting/expenses') }}
        onExpenseChanged={handleExpenseChanged}
        onSaved={() => { setModalOpen(false); router.replace('/admin/accounting/expenses'); void load() }}
        onDeleted={() => { setModalOpen(false); router.replace('/admin/accounting/expenses'); void load() }}
      />

      <LinkedBankTransactionDialog
        open={!!linkedTransactionId}
        transactionId={linkedTransactionId}
        onOpenChange={open => { if (!open) setLinkedTransactionId(null) }}
        onViewExpense={expenseId => {
          setModalExpenseId(expenseId)
          setModalOpen(true)
          setLinkedTransactionId(null)
        }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete expense?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>{deleteTarget?.supplierName ?? deleteTarget?.description}</strong>? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row justify-end gap-2">
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
