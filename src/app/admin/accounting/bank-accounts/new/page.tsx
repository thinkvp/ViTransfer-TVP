'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch } from '@/lib/api-client'
import { ArrowLeft } from 'lucide-react'

export default function NewBankAccountPage() {
  const router = useRouter()
  const [form, setForm] = useState({
    name: '', bankName: '', bsb: '', accountNumber: '',
    currency: 'AUD', openingBalance: '0.00', openingBalanceDate: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
        isActive: true,
      }
      const res = await apiFetch('/api/admin/accounting/bank-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Failed to create')
        return
      }
      router.push('/admin/accounting/bank-accounts')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push('/admin/accounting/bank-accounts')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-semibold">New Bank Account</h2>
      </div>
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="name">Account Name *</Label>
            <Input id="name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Main Operating Account" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="bank">Bank Name</Label>
              <Input id="bank" value={form.bankName} onChange={e => setForm(f => ({ ...f, bankName: e.target.value }))} placeholder="e.g. Commonwealth Bank" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="currency">Currency</Label>
              <Input id="currency" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} placeholder="AUD" maxLength={3} className="max-w-[100px]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="bsb">BSB</Label>
              <Input id="bsb" value={form.bsb} onChange={e => setForm(f => ({ ...f, bsb: e.target.value }))} placeholder="000-000" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="accnum">Account Number</Label>
              <Input id="accnum" value={form.accountNumber} onChange={e => setForm(f => ({ ...f, accountNumber: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="balance">Opening Balance ($)</Label>
              <Input id="balance" type="number" step="0.01" value={form.openingBalance} onChange={e => setForm(f => ({ ...f, openingBalance: e.target.value }))} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="baldate">Opening Balance Date</Label>
              <Input id="baldate" type="date" value={form.openingBalanceDate} onChange={e => setForm(f => ({ ...f, openingBalanceDate: e.target.value }))} />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2 pt-2">
            <Button onClick={handleSave} disabled={saving || !form.name.trim()}>
              {saving ? 'Saving…' : 'Create Account'}
            </Button>
            <Button variant="outline" onClick={() => router.push('/admin/accounting/bank-accounts')}>Cancel</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
