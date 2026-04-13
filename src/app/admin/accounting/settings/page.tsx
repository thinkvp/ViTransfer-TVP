'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { apiFetch } from '@/lib/api-client'
import { Plus, Pencil, Trash2, Check, X, Loader2 } from 'lucide-react'
import { AccountingTableActionButton } from '@/components/admin/accounting/AccountingTableActionButton'
import { cn } from '@/lib/utils'
import type { AccountingSettings } from '@/lib/accounting/types'

interface TaxRate {
  id: string
  name: string
  code: string
  rate: number
  isDefault: boolean
  isActive: boolean
  sortOrder: number
  notes: string | null
}

const TAX_CODES = [
  { value: 'GST', label: 'GST' },
  { value: 'GST_FREE', label: 'GST Free' },
  { value: 'BAS_EXCLUDED', label: 'BAS Excluded' },
  { value: 'INPUT_TAXED', label: 'Input Taxed' },
] as const

type TaxCodeValue = typeof TAX_CODES[number]['value']

interface FormState {
  name: string
  code: TaxCodeValue
  rate: string
  isDefault: boolean
  isActive: boolean
  sortOrder: string
  notes: string
}

const emptyForm = (): FormState => ({
  name: '',
  code: 'GST',
  rate: '0.10',
  isDefault: false,
  isActive: true,
  sortOrder: '0',
  notes: '',
})

export default function AccountingSettingsPage() {
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [loading, setLoading] = useState(true)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [editId, setEditId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TaxRate | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [reportingBasis, setReportingBasis] = useState<'CASH' | 'ACCRUAL'>('ACCRUAL')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/admin/accounting/tax-rates?includeInactive=true')
      if (res.ok) { const d = await res.json(); setTaxRates(d.taxRates ?? []) }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      setSettingsLoading(true)
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

  async function handleSettingsSave() {
    setSettingsSaving(true)
    setSettingsError('')
    setSettingsSaved(false)
    try {
      const res = await apiFetch('/api/admin/accounting/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportingBasis }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setSettingsError(d.error || 'Failed to save settings')
        return
      }
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2000)
    } finally {
      setSettingsSaving(false)
    }
  }

  function startEdit(rate: TaxRate) {
    setEditId(rate.id)
    setShowAdd(false)
    setForm({
      name: rate.name,
      code: rate.code as TaxCodeValue,
      rate: String(rate.rate),
      isDefault: rate.isDefault,
      isActive: rate.isActive,
      sortOrder: String(rate.sortOrder),
      notes: rate.notes ?? '',
    })
    setError('')
  }

  function cancelEdit() {
    setEditId(null)
    setShowAdd(false)
    setForm(emptyForm())
    setError('')
  }

  async function handleSave(id?: string) {
    setError('')
    const rateVal = parseFloat(form.rate)
    if (!form.name.trim()) { setError('Name is required'); return }
    if (isNaN(rateVal) || rateVal < 0 || rateVal > 1) { setError('Rate must be between 0 and 1 (e.g. 0.10 for 10%)'); return }
    setSaving(true)
    try {
      const body = {
        name: form.name.trim(),
        code: form.code,
        rate: rateVal,
        isDefault: form.isDefault,
        isActive: form.isActive,
        sortOrder: parseInt(form.sortOrder) || 0,
        notes: form.notes.trim() || null,
      }
      const res = id
        ? await apiFetch(`/api/admin/accounting/tax-rates/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await apiFetch('/api/admin/accounting/tax-rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to save'); return }
      cancelEdit()
      await load()
    } finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/admin/accounting/tax-rates/${deleteTarget.id}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete'); return }
      setDeleteTarget(null)
      await load()
    } finally { setDeleting(false) }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-xl font-semibold">Accounting Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">Manage reporting defaults and tax rates used when posting bank transactions.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Reporting</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1 max-w-sm">
            <Label>Reporting Basis</Label>
            <Select value={reportingBasis} onValueChange={v => setReportingBasis(v as 'CASH' | 'ACCRUAL')} disabled={settingsLoading || settingsSaving}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACCRUAL">Accrual (invoice date)</SelectItem>
                <SelectItem value="CASH">Cash (payment date)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Used by the Accounting dashboard, Profit &amp; Loss report, and new BAS periods.</p>
          </div>
          {settingsError && <p className="text-xs text-destructive">{settingsError}</p>}
          {settingsSaved && <p className="text-xs text-emerald-600 dark:text-emerald-400">Changes saved successfully!</p>}
          <div>
            <Button onClick={() => void handleSettingsSave()} disabled={settingsLoading || settingsSaving}>
              {settingsSaving ? 'Saving…' : 'Save Reporting Settings'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tax Rates */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">Tax Rates</CardTitle>
            {!showAdd && editId === null && (
              <Button size="sm" onClick={() => { setShowAdd(true); setEditId(null); setForm(emptyForm()); setError('') }}>
                <Plus className="w-4 h-4 mr-1.5" />Add Tax Rate
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Add form */}
          {showAdd && (
            <div className="px-4 py-3 border-b border-border bg-muted/10">
              <TaxRateForm form={form} setForm={setForm} error={error} saving={saving} onSave={() => void handleSave()} onCancel={cancelEdit} isNew />
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center text-muted-foreground text-sm flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />Loading…
            </div>
          ) : taxRates.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">No tax rates configured.</div>
          ) : (
            <>
              <div className="hidden sm:grid grid-cols-[1fr_110px_80px_80px_60px_80px] gap-2 px-4 py-2 bg-muted/40 border-b border-border text-xs font-medium text-muted-foreground">
                <div>Name</div>
                <div>Code</div>
                <div>Rate</div>
                <div>Default</div>
                <div>Active</div>
                <div />
              </div>
              <div className="divide-y divide-border">
                {taxRates.map(rate => (
                  <div key={rate.id}>
                    {editId === rate.id ? (
                      <div className="px-4 py-3 bg-muted/10">
                        <TaxRateForm form={form} setForm={setForm} error={error} saving={saving} onSave={() => void handleSave(rate.id)} onCancel={cancelEdit} />
                      </div>
                    ) : (
                      <div className="grid grid-cols-[1fr] sm:grid-cols-[1fr_110px_80px_80px_60px_80px] gap-2 px-4 py-2.5 items-center">
                        <div>
                          <p className="text-sm font-medium">{rate.name}</p>
                          {rate.notes && <p className="text-xs text-muted-foreground">{rate.notes}</p>}
                        </div>
                        <div className="hidden sm:block">
                          <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{rate.code}</span>
                        </div>
                        <div className="hidden sm:block text-sm tabular-nums">{(rate.rate * 100).toFixed(1)}%</div>
                        <div className="hidden sm:block">
                          {rate.isDefault && <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />}
                        </div>
                        <div className="hidden sm:block">
                          <span className={cn('text-xs', rate.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                            {rate.isActive ? 'Active' : 'Off'}
                          </span>
                        </div>
                        <div className="hidden sm:flex items-center gap-1 justify-end">
                          <AccountingTableActionButton className="h-8 w-8" onClick={() => startEdit(rate)} title="Edit tax rate" aria-label="Edit tax rate">
                            <Pencil className="w-3.5 h-3.5" />
                          </AccountingTableActionButton>
                          <AccountingTableActionButton className="h-8 w-8" destructive onClick={() => setDeleteTarget(rate)} title="Delete tax rate" aria-label="Delete tax rate">
                            <Trash2 className="w-3.5 h-3.5" />
                          </AccountingTableActionButton>
                        </div>
                        {/* Mobile row */}
                        <div className="sm:hidden flex items-center justify-between mt-1">
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{rate.code}</span>
                            <span>{(rate.rate * 100).toFixed(1)}%</span>
                            {rate.isDefault && <span className="text-emerald-600 dark:text-emerald-400">Default</span>}
                          </div>
                          <div className="flex items-center gap-1">
                            <AccountingTableActionButton className="h-8 w-8" onClick={() => startEdit(rate)} title="Edit tax rate" aria-label="Edit tax rate"><Pencil className="w-3.5 h-3.5" /></AccountingTableActionButton>
                            <AccountingTableActionButton className="h-8 w-8" destructive onClick={() => setDeleteTarget(rate)} title="Delete tax rate" aria-label="Delete tax rate"><Trash2 className="w-3.5 h-3.5" /></AccountingTableActionButton>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Delete dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tax Rate?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove &ldquo;{deleteTarget?.name}&rdquo;? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} disabled={deleting} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface TaxRateFormProps {
  form: FormState
  setForm: (fn: (prev: FormState) => FormState) => void
  error: string
  saving: boolean
  onSave: () => void
  onCancel: () => void
  isNew?: boolean
}

function TaxRateForm({ form, setForm, error, saving, onSave, onCancel, isNew }: TaxRateFormProps) {
  const upd = (updates: Partial<FormState>) => setForm(prev => ({ ...prev, ...updates }))
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input className="h-8 text-sm" value={form.name} onChange={e => upd({ name: e.target.value })} placeholder="e.g. GST (10%)" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Code</Label>
          <Select value={form.code} onValueChange={v => upd({ code: v as TaxCodeValue })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TAX_CODES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Rate (0–1, e.g. 0.10)</Label>
          <Input className="h-8 text-sm" type="number" step="0.01" min="0" max="1" value={form.rate} onChange={e => upd({ rate: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Sort Order</Label>
          <Input className="h-8 text-sm" type="number" value={form.sortOrder} onChange={e => upd({ sortOrder: e.target.value })} />
        </div>
        <div className="flex items-center gap-3 pt-5">
          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="checkbox" checked={form.isDefault} onChange={e => upd({ isDefault: e.target.checked })} />
            Default
          </label>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="checkbox" checked={form.isActive} onChange={e => upd({ isActive: e.target.checked })} />
            Active
          </label>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Notes</Label>
          <Input className="h-8 text-sm" value={form.notes} onChange={e => upd({ notes: e.target.value })} placeholder="Optional" />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1" />}
          {isNew ? 'Add' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          <X className="w-3.5 h-3.5 mr-1" />Cancel
        </Button>
      </div>
    </div>
  )
}
