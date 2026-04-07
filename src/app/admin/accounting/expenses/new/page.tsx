'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/lib/api-client'
import { ArrowLeft, Upload, Camera } from 'lucide-react'
import type { AccountTaxCode, AccountType } from '@/lib/accounting/types'
import { TAX_CODE_LABELS, ACCOUNT_TYPE_LABELS } from '@/lib/accounting/types'
import type { Account } from '@/lib/accounting/types'
import { cn } from '@/lib/utils'

export default function NewExpensePage() {
  const router = useRouter()
  const [accounts, setAccounts] = useState<Account[]>([])
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
  const [error, setError] = useState('')
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [accountSearch, setAccountSearch] = useState('')
  const [accountOpen, setAccountOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    apiFetch('/api/admin/accounting/accounts?expenseTypes=true&activeOnly=true').then(async res => {
      if (res.ok) { const d = await res.json(); setAccounts(d.accounts ?? []) }
    })
  }, [])

  async function handleSave() {
    setError('')
    setSaving(true)
    try {
      const parsedAmount = parseFloat(form.amountIncGst)
      if (isNaN(parsedAmount) || parsedAmount <= 0) { setError('Enter a valid amount'); setSaving(false); return }
      if (!form.accountId) { setError('Select an account'); setSaving(false); return }
      const body = {
        date: form.date,
        supplierName: form.supplierName.trim() || null,
        description: form.description.trim(),
        accountId: form.accountId,
        taxCode: form.taxCode,
        amountIncGst: parsedAmount,
        notes: form.notes.trim() || null,
      }
      const res = await apiFetch('/api/admin/accounting/expenses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to save')
        return
      }
      const saved = await res.json()
      const savedId = saved.expense?.id
      if (receiptFile && savedId) {
        const fd = new FormData()
        fd.append('file', receiptFile)
        await apiFetch(`/api/admin/accounting/expenses/${savedId}/receipt`, { method: 'POST', body: fd })
      }
      router.push('/admin/accounting/expenses')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push('/admin/accounting/expenses')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-semibold">New Expense</h2>
      </div>
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="date">Date *</Label>
              <Input id="date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="supplier">Supplier</Label>
              <Input id="supplier" value={form.supplierName} onChange={e => setForm(f => ({ ...f, supplierName: e.target.value }))} placeholder="Supplier name (optional)" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="desc">Description *</Label>
            <Input id="desc" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Description of expense" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="account">Account *</Label>
              <div className="relative">
                <Input
                  id="account"
                  className="h-9"
                  placeholder="Search account…"
                  autoComplete="off"
                  value={accountOpen ? accountSearch : (() => { const a = accounts.find(x => x.id === form.accountId); return a ? `${ACCOUNT_TYPE_LABELS[a.type as AccountType]} — ${a.name}` : '' })()}
                  onFocus={() => { setAccountOpen(true); setAccountSearch('') }}
                  onBlur={() => setTimeout(() => setAccountOpen(false), 150)}
                  onChange={e => setAccountSearch(e.target.value)}
                />
                {accountOpen && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-52 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                    {[...accounts]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .filter(a => { const q = accountSearch.toLowerCase(); return !q || a.name.toLowerCase().includes(q) || ACCOUNT_TYPE_LABELS[a.type as AccountType]?.toLowerCase().includes(q) })
                      .map(a => (
                        <button key={a.id} type="button"
                          onMouseDown={() => { setForm(f => ({ ...f, accountId: a.id })); setAccountSearch(''); setAccountOpen(false) }}
                          className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors', form.accountId === a.id && 'bg-primary/10 font-medium')}
                        >{ACCOUNT_TYPE_LABELS[a.type as AccountType]} — {a.name}</button>
                      ))}
                    {[...accounts].filter(a => { const q = accountSearch.toLowerCase(); return !q || a.name.toLowerCase().includes(q) || ACCOUNT_TYPE_LABELS[a.type as AccountType]?.toLowerCase().includes(q) }).length === 0 && (
                      <p className="px-3 py-2 text-sm text-muted-foreground">No accounts found.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="taxcode">Tax Code</Label>
              <Select value={form.taxCode} onValueChange={v => setForm(f => ({ ...f, taxCode: v as AccountTaxCode }))}>
                <SelectTrigger id="taxcode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.entries(TAX_CODE_LABELS) as [AccountTaxCode, string][]).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="amount">Amount inc. GST ($) *</Label>
            <Input id="amount" type="number" step="0.01" min="0" value={form.amountIncGst} onChange={e => setForm(f => ({ ...f, amountIncGst: e.target.value }))} placeholder="0.00" className="max-w-[160px]" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" rows={2} />
          </div>
          <div className="space-y-1">
            <Label>Receipt (optional)</Label>
            <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={e => setReceiptFile(e.target.files?.[0] ?? null)} />
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => setReceiptFile(e.target.files?.[0] ?? null)} />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                {receiptFile ? receiptFile.name : 'Upload receipt'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => cameraInputRef.current?.click()}>
                <Camera className="w-3.5 h-3.5 mr-1.5" />Take photo
              </Button>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2 pt-2">
            <Button onClick={handleSave} disabled={saving || !form.description.trim() || !form.amountIncGst || !form.accountId}>
              {saving ? 'Saving…' : 'Create Expense'}
            </Button>
            <Button variant="outline" onClick={() => router.push('/admin/accounting/expenses')}>Cancel</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
