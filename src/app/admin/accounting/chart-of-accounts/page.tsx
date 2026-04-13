'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-client'
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import type { Account, AccountType, AccountTaxCode } from '@/lib/accounting/types'
import { ACCOUNT_TYPE_LABELS, TAX_CODE_LABELS } from '@/lib/accounting/types'
import { AccountingTableActionButton } from '@/components/admin/accounting/AccountingTableActionButton'
import { cn } from '@/lib/utils'
import { DateRangePreset, getThisFinancialYearDates } from '@/components/admin/accounting/DateRangePreset'
import { ExportMenu, downloadCsv, downloadPdf } from '@/components/admin/accounting/ExportMenu'

const TYPE_BADGE: Record<AccountType, string> = {
  ASSET: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  LIABILITY: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  EQUITY: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  INCOME: 'bg-green-500/15 text-green-700 dark:text-green-400',
  COGS: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
  EXPENSE: 'bg-red-500/15 text-red-700 dark:text-red-400',
}

function fmtAud(cents: number) {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type CoaSortKey = 'code' | 'name' | 'type' | 'taxCode' | 'status'

const COA_PAGE_SIZE = 50

const EMPTY_FORM = {
  code: '', name: '', type: 'EXPENSE' as AccountType, subType: '',
  taxCode: 'GST' as AccountTaxCode, description: '', isActive: true, parentId: '',
}

export default function ChartOfAccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<AccountType | 'ALL'>('ALL')
  const [sortKey, setSortKey] = useState<CoaSortKey>('code')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)

  const [balanceFrom, setBalanceFrom] = useState(() => getThisFinancialYearDates().from)
  const [balanceTo, setBalanceTo] = useState(() => getThisFinancialYearDates().to)
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [loadingBalances, setLoadingBalances] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/admin/accounting/accounts?includeChildren=true')
      if (res.ok) {
        const data = await res.json()
        setAccounts(data.accounts ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const loadBalances = useCallback(async (from: string, to: string) => {
    setLoadingBalances(true)
    try {
      const params = new URLSearchParams()
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      const res = await apiFetch(`/api/admin/accounting/accounts/balances?${params}`)
      if (res.ok) {
        const data = await res.json()
        setBalances(data.balances ?? {})
      }
    } finally {
      setLoadingBalances(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { void loadBalances(balanceFrom, balanceTo) }, [loadBalances, balanceFrom, balanceTo])

  // All accounts flattened (top-level accounts with children always expanded below them)
  const flat = useMemo(() => {
    const rows: Array<{ account: Account; depth: number }> = []
    function walk(acc: Account, depth: number) {
      rows.push({ account: acc, depth })
      acc.children?.forEach(c => walk(c, depth + 1))
    }
    accounts.filter(a => !a.parentId).forEach(a => walk(a, 0))
    return rows
  }, [accounts])

  // Top-level accounts only (for parent selector — no sub-sub-accounts)
  const topLevelAccounts = useMemo(() => {
    return accounts.filter(a => !a.parentId)
  }, [accounts])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return flat.filter(({ account: a }) => {
      if (filterType !== 'ALL' && a.type !== filterType) return false
      if (q) return a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
      return true
    })
  }, [flat, search, filterType])

  const sortedAndPaged = useMemo(() => {
    function cmp(a: Account, b: Account): number {
      let r = 0
      switch (sortKey) {
        case 'code': r = a.code.localeCompare(b.code); break
        case 'name': r = a.name.localeCompare(b.name); break
        case 'type': r = a.type.localeCompare(b.type); break
        case 'taxCode': r = a.taxCode.localeCompare(b.taxCode); break
        case 'status': r = (a.isActive ? 0 : 1) - (b.isActive ? 0 : 1); break
      }
      return sortDir === 'asc' ? r : -r
    }
    // Sort top-level accounts; children follow their parent (also sorted within each parent)
    const topLevelRows = filtered.filter(({ account }) => !account.parentId)
    const childMap: Record<string, typeof filtered> = {}
    filtered.filter(({ account }) => account.parentId).forEach(row => {
      const pid = row.account.parentId!
      if (!childMap[pid]) childMap[pid] = []
      childMap[pid].push(row)
    })
    topLevelRows.sort((a, b) => cmp(a.account, b.account))
    Object.values(childMap).forEach(arr => arr.sort((a, b) => cmp(a.account, b.account)))
    const sorted: typeof filtered = []
    for (const parent of topLevelRows) {
      sorted.push(parent)
      sorted.push(...(childMap[parent.account.id] ?? []))
    }
    return sorted
  }, [filtered, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sortedAndPaged.length / COA_PAGE_SIZE))
  const paged = useMemo(() => sortedAndPaged.slice((page - 1) * COA_PAGE_SIZE, page * COA_PAGE_SIZE), [sortedAndPaged, page])

  function toggleSort(key: CoaSortKey) {
    setSortKey(prev => {
      if (prev !== key) { setSortDir('asc'); return key }
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
      return prev
    })
    setPage(1)
  }

  function openNew() {
    setForm({ ...EMPTY_FORM })
    setEditId(null)
    setFormError('')
    setModalOpen(true)
  }

  function openEdit(a: Account) {
    setForm({
      code: a.code, name: a.name, type: a.type, subType: a.subType ?? '',
      taxCode: a.taxCode, description: a.description ?? '', isActive: a.isActive, parentId: a.parentId ?? '',
    })
    setEditId(a.id)
    setFormError('')
    setModalOpen(true)
  }

  function openAddChild(parent: Account) {
    // Only allow adding children to top-level accounts (no sub-sub-accounts)
    if (parent.parentId) return
    setForm({ ...EMPTY_FORM, code: parent.code + '-', type: parent.type, taxCode: parent.taxCode, parentId: parent.id })
    setEditId(null)
    setFormError('')
    setModalOpen(true)
  }

  async function handleSave() {
    setFormError('')
    setSaving(true)
    try {
      const body = {
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        subType: form.subType.trim() || null,
        taxCode: form.taxCode,
        description: form.description.trim() || null,
        isActive: form.isActive,
        parentId: form.parentId.trim() || null,
      }
      const url = editId ? `/api/admin/accounting/accounts/${editId}` : '/api/admin/accounting/accounts'
      const method = editId ? 'PUT' : 'POST'
      const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setFormError(d.error || 'Failed to save account')
        return
      }
      setModalOpen(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/accounts/${deleteTarget.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || 'Failed to delete account')
        return
      }
      setDeleteTarget(null)
      await load()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">Chart of Accounts</h2>
          <p className="text-sm text-muted-foreground">Manage your account codes for expenses, income, and balance sheet items.</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu
            onExportCsv={() => {
              downloadCsv('chart-of-accounts.csv', ['Code', 'Name', 'Type', 'Tax Code', 'Active'], filtered.map(({ account: a }) => [
                a.code, a.name, ACCOUNT_TYPE_LABELS[a.type as AccountType] ?? a.type, TAX_CODE_LABELS[a.taxCode as AccountTaxCode] ?? a.taxCode ?? '', a.isActive ? 'Yes' : 'No',
              ]))
            }}
            onExportPdf={() => downloadPdf('Chart of Accounts')}
          />
          <Button onClick={openNew}><Plus className="w-4 h-4 mr-1.5" />New Account</Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap gap-2 items-start justify-between">
            <div className="flex flex-wrap gap-2">
              <Input
                placeholder="Search code or name…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-9 max-w-xs"
              />
              <Select value={filterType} onValueChange={v => setFilterType(v as AccountType | 'ALL')}>
                <SelectTrigger className="h-9 w-40">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All types</SelectItem>
                  {(Object.entries(ACCOUNT_TYPE_LABELS) as [AccountType, string][]).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Balance period:</span>
              <DateRangePreset
                from={balanceFrom}
                to={balanceTo}
                onFromChange={v => { setBalanceFrom(v) }}
                onToChange={v => { setBalanceTo(v) }}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">Loading…</div>
          ) : paged.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">No accounts found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b border-border">
                    {([
                      { key: 'code', label: 'Code', cls: 'w-28' },
                      { key: 'name', label: 'Name', cls: '' },
                      { key: 'type', label: 'Type', cls: 'min-w-[100px]' },
                      { key: 'taxCode', label: 'Tax Code', cls: 'min-w-[100px]' },
                      { key: 'status', label: 'Status', cls: '' },
                    ] as { key: CoaSortKey; label: string; cls: string }[]).map(col => (
                      <th key={col.key} className={`px-3 py-2 text-left text-xs font-medium text-muted-foreground ${col.cls}`}>
                        <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                          {col.label}
                          {sortKey === col.key ? (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : null}
                        </button>
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground min-w-[110px]">
                      Balance{loadingBalances ? ' …' : ''}
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map(({ account: a, depth }) => (
                    <tr key={a.id} className={cn('border-b border-border last:border-b-0 hover:bg-muted/40', depth > 0 && 'bg-muted/10')}>
                      <td className="px-3 py-2 tabular-nums font-mono text-xs">{a.code}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
                          {depth > 0 && <span className="text-muted-foreground/40 text-xs select-none">└</span>}
                          <Link href={`/admin/accounting/chart-of-accounts/${a.code}`} className="hover:underline underline-offset-2">{a.name}</Link>
                          {a.isSystem && <span className="text-xs text-muted-foreground">(system)</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={cn('inline-flex px-2 py-0.5 rounded text-xs font-medium', TYPE_BADGE[a.type])}>
                          {ACCOUNT_TYPE_LABELS[a.type]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-sm text-muted-foreground">{TAX_CODE_LABELS[a.taxCode]}</td>
                      <td className="px-3 py-2">
                        <span className={cn('text-xs', a.isActive ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}>
                          {a.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-sm">
                        {balances[a.id] !== undefined ? fmtAud(balances[a.id]) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {!a.parentId && (
                            <AccountingTableActionButton onClick={() => openAddChild(a)} title="Add sub-account" aria-label="Add sub-account">
                              <Plus className="w-3.5 h-3.5" />
                            </AccountingTableActionButton>
                          )}
                          <AccountingTableActionButton onClick={() => openEdit(a)} title="Edit account" aria-label="Edit account">
                            <Pencil className="w-3.5 h-3.5" />
                          </AccountingTableActionButton>
                          {!a.isSystem && (
                            <AccountingTableActionButton destructive onClick={() => setDeleteTarget(a)} title="Delete account" aria-label="Delete account">
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{sortedAndPaged.length} accounts</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage(1)}><ChevronsLeft className="w-3.5 h-3.5" /></Button>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft className="w-3.5 h-3.5" /></Button>
            <span className="px-3 text-muted-foreground">Page {page} of {totalPages}</span>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight className="w-3.5 h-3.5" /></Button>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage(totalPages)}><ChevronsRight className="w-3.5 h-3.5" /></Button>
          </div>
        </div>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={modalOpen} onOpenChange={v => { if (!saving) setModalOpen(v) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editId ? 'Edit Account' : 'New Account'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="acc-code">Code *</Label>
                <Input id="acc-code" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="e.g. 6-1000" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="acc-type">Type *</Label>
                <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v as AccountType }))}>
                  <SelectTrigger id="acc-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.entries(ACCOUNT_TYPE_LABELS) as [AccountType, string][]).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-name">Name *</Label>
              <Input id="acc-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Office Supplies" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="acc-tax">Tax Code</Label>
                <Select value={form.taxCode} onValueChange={v => setForm(f => ({ ...f, taxCode: v as AccountTaxCode }))}>
                  <SelectTrigger id="acc-tax"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.entries(TAX_CODE_LABELS) as [AccountTaxCode, string][]).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="acc-subtype">Sub-type</Label>
                <Input id="acc-subtype" value={form.subType} onChange={e => setForm(f => ({ ...f, subType: e.target.value }))} placeholder="Optional" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-desc">Description</Label>
              <Input id="acc-desc" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-parent">Parent Account</Label>
              <p className="text-xs text-muted-foreground">Sub-accounts of sub-accounts are not allowed.</p>
              <Select value={form.parentId || '_none'} onValueChange={v => setForm(f => ({ ...f, parentId: v === '_none' ? '' : v }))}>
                <SelectTrigger id="acc-parent"><SelectValue placeholder="None (top-level)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">None (top-level)</SelectItem>
                  {[...topLevelAccounts].sort((a, b) => a.name.localeCompare(b.name)).filter(a => a.id !== editId).map(a => (
                    <SelectItem key={a.id} value={a.id}>{ACCOUNT_TYPE_LABELS[a.type]} — {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="acc-active" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} className="rounded" />
              <Label htmlFor="acc-active">Active</Label>
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || !form.code.trim() || !form.name.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{deleteTarget?.code} — {deleteTarget?.name}</strong>.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
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
