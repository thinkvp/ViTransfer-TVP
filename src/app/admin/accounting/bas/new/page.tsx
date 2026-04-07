'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CalendarRange, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/lib/api-client'
import type { AccountingSettings } from '@/lib/accounting/types'

const QUARTERS = [
  { q: 1, label: 'Q1 — July to September' },
  { q: 2, label: 'Q2 — October to December' },
  { q: 3, label: 'Q3 — January to March' },
  { q: 4, label: 'Q4 — April to June' },
]

function quarterDates(quarter: number, financialYear: string): { startDate: string; endDate: string } {
  const fy = parseInt(financialYear, 10)

  switch (quarter) {
    case 1:
      return { startDate: `${fy - 1}-07-01`, endDate: `${fy - 1}-09-30` }
    case 2:
      return { startDate: `${fy - 1}-10-01`, endDate: `${fy - 1}-12-31` }
    case 3:
      return { startDate: `${fy}-01-01`, endDate: `${fy}-03-31` }
    case 4:
      return { startDate: `${fy}-04-01`, endDate: `${fy}-06-30` }
    default:
      return { startDate: '', endDate: '' }
  }
}

const currentYear = new Date().getFullYear()
const FY_YEARS = Array.from({ length: 5 }, (_, index) => String(currentYear - 2 + index))

type FormState = {
  quarter: string
  financialYear: string
  startDate: string
  endDate: string
  label: string
  notes: string
}

export default function NewBasPage() {
  const router = useRouter()
  const [form, setForm] = useState<FormState>({
    quarter: '1',
    financialYear: String(currentYear),
    startDate: '',
    endDate: '',
    label: '',
    notes: '',
  })
  const [reportingBasis, setReportingBasis] = useState<'CASH' | 'ACCRUAL'>('ACCRUAL')
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [addingAll, setAddingAll] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const initialDates = quarterDates(1, String(currentYear))
    setForm((current) => ({
      ...current,
      startDate: initialDates.startDate,
      endDate: initialDates.endDate,
      label: `Q1 FY${currentYear}`,
    }))
  }, [])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const res = await apiFetch('/api/admin/accounting/settings')
        const data: AccountingSettings | null = res.ok ? await res.json() : null
        if (!cancelled) setReportingBasis(data?.reportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL')
      } finally {
        if (!cancelled) setSettingsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  function handleQuarterChange(quarter: string) {
    const { startDate, endDate } = quarterDates(parseInt(quarter, 10), form.financialYear)
    setForm((current) => ({
      ...current,
      quarter,
      startDate,
      endDate,
      label: `Q${quarter} FY${current.financialYear}`,
    }))
  }

  function handleFyChange(financialYear: string) {
    const { startDate, endDate } = quarterDates(parseInt(form.quarter, 10), financialYear)
    setForm((current) => ({
      ...current,
      financialYear,
      startDate,
      endDate,
      label: `Q${current.quarter} FY${financialYear}`,
    }))
  }

  async function handleAddAllFy() {
    setError('')
    setAddingAll(true)

    try {
      const fy = form.financialYear
      const results = await Promise.all(
        [1, 2, 3, 4].map((quarter) => {
          const { startDate, endDate } = quarterDates(quarter, fy)
          return apiFetch('/api/admin/accounting/bas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              label: `Q${quarter} FY${fy}`,
              startDate,
              endDate,
              quarter,
              financialYear: fy,
              notes: null,
            }),
          })
        })
      )

      const failed = results.filter((result) => !result.ok)
      if (failed.length > 0) {
        setError(`${failed.length} period(s) could not be created (may already exist).`)
        return
      }

      router.push('/admin/accounting/bas')
    } finally {
      setAddingAll(false)
    }
  }

  async function handleSave() {
    setError('')
    setSaving(true)

    try {
      if (!form.startDate || !form.endDate) {
        setError('Select dates')
        return
      }

      const body = {
        label: form.label.trim() || `Q${form.quarter} FY${form.financialYear}`,
        startDate: form.startDate,
        endDate: form.endDate,
        quarter: parseInt(form.quarter, 10),
        financialYear: form.financialYear,
        notes: form.notes.trim() || null,
      }

      const res = await apiFetch('/api/admin/accounting/bas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Failed to create')
        return
      }

      const data = await res.json()
      router.push(`/admin/accounting/bas/${data.period?.id ?? ''}`)
    } finally {
      setSaving(false)
    }
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
                  {QUARTERS.map((quarter) => (
                    <SelectItem key={quarter.q} value={String(quarter.q)}>{quarter.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Financial Year (ending Jun)</Label>
              <Select value={form.financialYear} onValueChange={handleFyChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FY_YEARS.map((fy) => (
                    <SelectItem key={fy} value={fy}>FY{fy}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Start Date</Label>
              <Input type="date" value={form.startDate} onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>End Date</Label>
              <Input type="date" value={form.endDate} onChange={(event) => setForm((current) => ({ ...current, endDate: event.target.value }))} />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Reporting Basis</Label>
            <div className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {settingsLoading ? 'Loading…' : reportingBasis === 'CASH' ? 'Cash (payment date)' : 'Accrual (invoice date)'}
            </div>
          </div>

          <div className="space-y-1">
            <Label>Label</Label>
            <Input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} placeholder={`Q${form.quarter} FY${form.financialYear}`} />
          </div>

          <div className="space-y-1">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} rows={2} placeholder="Optional notes" />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={handleSave} disabled={settingsLoading || saving || addingAll || !form.startDate || !form.endDate}>
              {saving ? 'Creating…' : 'Create Period'}
            </Button>
            <Button variant="secondary" onClick={() => void handleAddAllFy()} disabled={settingsLoading || saving || addingAll}>
              {addingAll ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <CalendarRange className="w-4 h-4 mr-1.5" />}
              Add All {reportingBasis === 'ACCRUAL' ? 'Accrual' : 'Cash'} FY{form.financialYear} Quarters
            </Button>
            <Button variant="outline" onClick={() => router.push('/admin/accounting/bas')}>Cancel</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
