'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/lib/api-client'
import { ArrowLeft, CalendarRange, Loader2 } from 'lucide-react'

// Australian quarters: Q1=Jul-Sep, Q2=Oct-Dec, Q3=Jan-Mar, Q4=Apr-Jun
const QUARTERS = [
  { q: 1, label: 'Q1 — July to September' },
  { q: 2, label: 'Q2 — October to December' },
  { q: 3, label: 'Q3 — January to March' },
  { q: 4, label: 'Q4 — April to June' },
]

function quarterDates(quarter: number, financialYear: string): { startDate: string; endDate: string } {
  const fy = parseInt(financialYear)
  switch (quarter) {
    case 1: return { startDate: `${fy - 1}-07-01`, endDate: `${fy - 1}-09-30` }
    case 2: return { startDate: `${fy - 1}-10-01`, endDate: `${fy - 1}-12-31` }
    case 3: return { startDate: `${fy}-01-01`, endDate: `${fy}-03-31` }
    case 4: return { startDate: `${fy}-04-01`, endDate: `${fy}-06-30` }
    default: return { startDate: '', endDate: '' }
  }
}

const currentYear = new Date().getFullYear()
const FY_YEARS = Array.from({ length: 5 }, (_, i) => String(currentYear - 2 + i))

export default function NewBasPage() {
  const router = useRouter()
  const [form, setForm] = useState({
    quarter: '1',
    financialYear: String(currentYear),
    startDate: '',
    endDate: '',
    basis: 'ACCRUAL' as 'CASH' | 'ACCRUAL',
    label: '',
    notes: '',
    customDates: false,
  })
  const [saving, setSaving] = useState(false)
  const [addingAll, setAddingAll] = useState(false)
  const [error, setError] = useState('')

  function handleQuarterChange(q: string) {
    const { startDate, endDate } = quarterDates(parseInt(q), form.financialYear)
    const fy = form.financialYear
    const qLabel = `Q${q} FY${fy}`
    setForm(f => ({ ...f, quarter: q, startDate, endDate, label: qLabel }))
  }

  function handleFyChange(fy: string) {
    const { startDate, endDate } = quarterDates(parseInt(form.quarter), fy)
    const qLabel = `Q${form.quarter} FY${fy}`
    setForm(f => ({ ...f, financialYear: fy, startDate, endDate, label: qLabel }))
  }

  async function handleAddAllFy() {
    setError('')
    setAddingAll(true)
    try {
      const fy = form.financialYear
      const basis = form.basis
      const results = await Promise.all(
        [1, 2, 3, 4].map(q => {
          const { startDate, endDate } = quarterDates(q, fy)
          return apiFetch('/api/admin/accounting/bas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: `Q${q} FY${fy}`, startDate, endDate, quarter: q, financialYear: fy, basis, notes: null }),
          })
        })
      )
      const failed = results.filter(r => !r.ok)
      if (failed.length > 0) {
        setError(`${failed.length} period(s) could not be created (may already exist).`)
      } else {
        router.push('/admin/accounting/bas')
      }
    } finally { setAddingAll(false) }
  }

  async function handleSave() {
    setError('')
    setSaving(true)
    try {
      if (!form.startDate || !form.endDate) { setError('Select dates'); setSaving(false); return }
      const body = {
        label: form.label.trim() || `Q${form.quarter} FY${form.financialYear}`,
        startDate: form.startDate,
        endDate: form.endDate,
        quarter: parseInt(form.quarter),
        financialYear: form.financialYear,
        basis: form.basis,
        notes: form.notes.trim() || null,
      }
      const res = await apiFetch('/api/admin/accounting/bas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to create'); return }
      const d = await res.json()
      router.push(`/admin/accounting/bas/${d.period?.id ?? ''}`)
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push('/admin/accounting/bas')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-semibold">New BAS Period</h2>
      </div>
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Quarter</Label>
              <Select value={form.quarter} onValueChange={handleQuarterChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {QUARTERS.map(q => <SelectItem key={q.q} value={String(q.q)}>{q.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Financial Year (ending Jun)</Label>
              <Select value={form.financialYear} onValueChange={handleFyChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FY_YEARS.map(fy => <SelectItem key={fy} value={fy}>FY{fy}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Start Date</Label>
              <Input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>End Date</Label>
              <Input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Reporting Basis</Label>
            <Select value={form.basis} onValueChange={v => setForm(f => ({ ...f, basis: v as 'CASH' | 'ACCRUAL' }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ACCRUAL">Accrual (invoice date)</SelectItem>
                <SelectItem value="CASH">Cash (payment date)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Label</Label>
            <Input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder={`Q${form.quarter} FY${form.financialYear}`} />
          </div>
          <div className="space-y-1">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Optional notes" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={handleSave} disabled={saving || addingAll || !form.startDate || !form.endDate}>
              {saving ? 'Creating…' : 'Create Period'}
            </Button>
            <Button variant="secondary" onClick={() => void handleAddAllFy()} disabled={saving || addingAll}>
              {addingAll ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <CalendarRange className="w-4 h-4 mr-1.5" />}
              Add All {form.basis === 'ACCRUAL' ? 'Accrual' : 'Cash'} FY{form.financialYear} Quarters
            </Button>
            <Button variant="outline" onClick={() => router.push('/admin/accounting/bas')}>Cancel</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
