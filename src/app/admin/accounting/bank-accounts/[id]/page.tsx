'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch } from '@/lib/api-client'
import { ArrowLeft } from 'lucide-react'
import { buildAccountOptions, type AccountOption } from '@/lib/accounting/account-options'
import type { BankAccount } from '@/lib/accounting/types'

const EMPTY_FORM = {
  name: '', bankName: '', bsb: '', accountNumber: '',
  currency: 'AUD', openingBalance: '0.00', openingBalanceDate: '', isActive: true,
  coaAccountId: '' as string,
  coaAccountSearch: '',
  coaAccountOpen: false,
}

export default function BankAccountFormPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const isNew = !params?.id || params.id === 'new'
  const accountId = params?.id && params.id !== 'new' ? params.id : null

  const [loading, setLoading] = useState(!isNew)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [assetAccounts, setAssetAccounts] = useState<AccountOption[]>([])

  const loadAccount = useCallback(async () => {
    if (!accountId) return
    setLoading(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/bank-accounts/${accountId}`)
      if (res.ok) {
        const d = await res.json()
        const a: BankAccount = d.bankAccount
        setForm({
          name: a.name,
          bankName: a.bankName ?? '',
          bsb: a.bsb ?? '',
          accountNumber: a.accountNumber ?? '',
          currency: a.currency,
          openingBalance: (a.openingBalance / 100).toFixed(2),
          openingBalanceDate: a.openingBalanceDate ?? '',
          isActive: a.isActive,
          coaAccountId: a.coaAccountId ?? '',
          coaAccountSearch: '',
          coaAccountOpen: false,
        })
      }
    } finally { setLoading(false) }
  }, [accountId])

  useEffect(() => {
    void loadAccount()
    apiFetch('/api/admin/accounting/accounts').then(async r => {
      if (r.ok) {
        const d = await r.json()
        setAssetAccounts(buildAccountOptions((d.accounts ?? []).filter((a: { type: string }) => a.type === 'ASSET')))
      }
    })
  }, [loadAccount])

  async function handleSave() {
    setError('')
    setSaving(true)
    try {
      if (!form.name.trim()) { setError('Account name is required'); setSaving(false); return }
      const balanceDollars = parseFloat(form.openingBalance || '0') || 0
      const body = {
        name: form.name.trim(),
        bankName: form.bankName.trim() || null,
        bsb: form.bsb.trim() || null,
        accountNumber: form.accountNumber.trim() || null,
        currency: form.currency,
        openingBalance: balanceDollars,
        openingBalanceDate: form.openingBalanceDate || null,
        isActive: form.isActive,
        coaAccountId: form.coaAccountId || null,
      }
      const url = accountId ? `/api/admin/accounting/bank-accounts/${accountId}` : '/api/admin/accounting/bank-accounts'
      const method = accountId ? 'PUT' : 'POST'
      const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to save')
        return
      }
      router.push('/admin/accounting/bank-accounts')
    } finally { setSaving(false) }
  }

  if (loading) return <div className="py-10 text-center text-muted-foreground">Loading…</div>

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push('/admin/accounting/bank-accounts')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-semibold">{isNew ? 'New Bank Account' : 'Edit Bank Account'}</h2>
      </div>

      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="ba-name">Account Name *</Label>
            <Input id="ba-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Main Operating Account" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="ba-bank">Bank Name</Label>
              <Input id="ba-bank" value={form.bankName} onChange={e => setForm(f => ({ ...f, bankName: e.target.value }))} placeholder="e.g. Commonwealth Bank" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-currency">Currency</Label>
              <Input id="ba-currency" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} placeholder="AUD" maxLength={3} className="max-w-[100px]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="ba-bsb">BSB</Label>
              <Input id="ba-bsb" value={form.bsb} onChange={e => setForm(f => ({ ...f, bsb: e.target.value }))} placeholder="000-000" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-accnum">Account Number</Label>
              <Input id="ba-accnum" value={form.accountNumber} onChange={e => setForm(f => ({ ...f, accountNumber: e.target.value }))} placeholder="Account number" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="ba-balance">Opening Balance ($)</Label>
              <Input id="ba-balance" type="number" step="0.01" value={form.openingBalance} onChange={e => setForm(f => ({ ...f, openingBalance: e.target.value }))} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-baldate">Opening Balance Date</Label>
              <Input id="ba-baldate" type="date" value={form.openingBalanceDate} onChange={e => setForm(f => ({ ...f, openingBalanceDate: e.target.value }))} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="ba-active" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} className="rounded" />
            <Label htmlFor="ba-active">Active</Label>
          </div>
          <div className="space-y-1">
            <Label>Chart of Accounts Link <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <p className="text-xs text-muted-foreground">Link to an ASSET account so this bank account&apos;s balance appears in the CoA with the correct account code.</p>
            <div className="relative">
              <Input
                className="h-9 text-sm"
                placeholder="Search asset accounts…"
                value={form.coaAccountOpen ? form.coaAccountSearch : (assetAccounts.find(a => a.id === form.coaAccountId)?.label ?? '')}
                onFocus={() => setForm(f => ({ ...f, coaAccountOpen: true, coaAccountSearch: '' }))}
                onBlur={() => setTimeout(() => setForm(f => ({ ...f, coaAccountOpen: false })), 150)}
                onChange={e => setForm(f => ({ ...f, coaAccountSearch: e.target.value }))}
              />
              {form.coaAccountOpen && (
                <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-48 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                  <button type="button"
                    onMouseDown={() => setForm(f => ({ ...f, coaAccountId: '', coaAccountSearch: '', coaAccountOpen: false }))}
                    className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 italic"
                  >
                    — No link
                  </button>
                  {assetAccounts
                    .filter(a => {
                      const q = form.coaAccountSearch.trim().toLowerCase()
                      return !q || a.searchText.includes(q)
                    })
                    .map(a => (
                      <button key={a.id} type="button"
                        onMouseDown={() => setForm(f => ({ ...f, coaAccountId: a.id, coaAccountSearch: '', coaAccountOpen: false }))}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors${form.coaAccountId === a.id ? ' bg-primary/10 font-medium' : ''}`}
                      >
                        {a.label}
                      </button>
                    ))
                  }
                </div>
              )}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2 pt-2">
            <Button onClick={handleSave} disabled={saving || !form.name.trim()}>
              {saving ? 'Saving…' : isNew ? 'Create Account' : 'Save Changes'}
            </Button>
            <Button variant="outline" onClick={() => router.push('/admin/accounting/bank-accounts')}>Cancel</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
