'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { apiFetch } from '@/lib/api-client'
import { Save, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AccountingSettings } from '@/lib/accounting/types'

export default function AccountingSettingsPage() {
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [reportingBasis, setReportingBasis] = useState<'CASH' | 'ACCRUAL'>('ACCRUAL')
  // BAS payment default accounts
  const [basGstAccountId, setBasGstAccountId] = useState('')
  const [basPaygAccountId, setBasPaygAccountId] = useState('')
  const [basPaygInstalmentDefault, setBasPaygInstalmentDefault] = useState('')
  const [basGstSearch, setBasGstSearch] = useState('')
  const [basGstOpen, setBasGstOpen] = useState(false)
  const [basPaygSearch, setBasPaygSearch] = useState('')
  const [basPaygOpen, setBasPaygOpen] = useState(false)
  // Stripe rounding account
  const [stripeRoundingAccountId, setStripeRoundingAccountId] = useState('')
  const [stripeRoundingSearch, setStripeRoundingSearch] = useState('')
  const [stripeRoundingOpen, setStripeRoundingOpen] = useState(false)
  // Live tax rate (read-only here — managed in Sales settings)
  const [salesTaxRatePercent, setSalesTaxRatePercent] = useState<number | null>(null)
  interface CoaOption { id: string; code: string; name: string; type: string }
  const [coaAccounts, setCoaAccounts] = useState<CoaOption[]>([])

  function selectedAccountLabel(accountId: string) {
    const account = coaAccounts.find(item => item.id === accountId)
    if (account) return `${account.code} — ${account.name}`
    return accountId ? '(unknown account)' : ''
  }

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      setSettingsLoading(true)
      try {
        const res = await apiFetch('/api/admin/accounting/settings')
        const data: AccountingSettings | null = res.ok ? await res.json() : null
        if (!cancelled) {
          setReportingBasis(data?.reportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL')
          setBasGstAccountId(data?.basGstAccountId ?? '')
          setBasPaygAccountId(data?.basPaygAccountId ?? '')
          setBasPaygInstalmentDefault(data?.basPaygInstalmentDefaultCents != null ? (data.basPaygInstalmentDefaultCents / 100).toFixed(2) : '')
          setStripeRoundingAccountId(data?.stripeRoundingAccountId ?? '')
        }
      } finally {
        if (!cancelled) setSettingsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    apiFetch('/api/admin/accounting/accounts?activeOnly=true')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.accounts) setCoaAccounts(d.accounts) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    apiFetch('/api/admin/sales/settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const rate = d?.settings?.taxRatePercent ?? d?.taxRatePercent
        if (typeof rate === 'number' && Number.isFinite(rate)) setSalesTaxRatePercent(rate)
      })
      .catch(() => {})
  }, [])

  async function handleSettingsSave() {
    setSettingsSaving(true)
    setSettingsError('')
    setSettingsSaved(false)
    try {
      const paygInstalmentDefaultRaw = basPaygInstalmentDefault.trim()
      let paygInstalmentDefaultCents: number | null = null
      if (paygInstalmentDefaultRaw !== '') {
        const parsedPaygInstalmentDefault = Number.parseFloat(paygInstalmentDefaultRaw)
        if (!Number.isFinite(parsedPaygInstalmentDefault) || parsedPaygInstalmentDefault < 0) {
          setSettingsError('Default T7 instalment amount must be 0 or greater')
          return
        }
        paygInstalmentDefaultCents = Math.round(parsedPaygInstalmentDefault * 100)
      }

      const res = await apiFetch('/api/admin/accounting/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportingBasis,
          basGstAccountId: basGstAccountId || null,
          basPaygAccountId: basPaygAccountId || null,
          basPaygInstalmentDefaultCents: paygInstalmentDefaultCents,
          stripeRoundingAccountId: stripeRoundingAccountId || null,
        }),
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

  return (
    <>
      <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Accounting Settings</h2>
          <p className="text-sm text-muted-foreground mt-1">Manage reporting defaults used when posting bank transactions and preparing BAS periods.</p>
        </div>
        <Button onClick={() => void handleSettingsSave()} variant="default" disabled={settingsLoading || settingsSaving} size="lg" className="w-full sm:w-auto">
          <Save className="w-4 h-4 mr-2" />
          {settingsSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>

      {settingsError && (
        <div className="p-3 sm:p-4 bg-destructive-visible border-2 border-destructive-visible rounded-lg">
          <p className="text-xs sm:text-sm text-destructive font-medium">{settingsError}</p>
        </div>
      )}

      {settingsSaved && (
        <div className="p-3 sm:p-4 bg-success-visible border-2 border-success-visible rounded-lg">
          <p className="text-xs sm:text-sm text-success font-medium">Changes saved successfully!</p>
        </div>
      )}

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
          <div className="space-y-1 max-w-sm">
            <Label>GST Rate</Label>
            <p className="text-sm">
              {salesTaxRatePercent != null ? `${salesTaxRatePercent}%` : '—'}
            </p>
            <p className="text-xs text-muted-foreground">
              All GST calculations (BAS, reports, ledgers) use the default tax rate from{' '}
              <Link href="/admin/sales/settings" className="underline underline-offset-2 inline-flex items-center gap-0.5">
                Sales Settings<ExternalLink className="w-3 h-3" />
              </Link>
              . Changing it recalculates historical reports and any BAS period that has not been lodged.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* BAS Payment Defaults */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">BAS Payment Defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Set the defaults used when recording BAS payments and pre-filling T7 on new BAS periods. These can still be overridden per period or payment.
          </p>
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="space-y-1">
              <Label>GST Payable Account</Label>
              <p className="text-xs text-muted-foreground">Receives the net GST component (1A − 1B). Typically a Liability account such as &ldquo;GST Payable&rdquo;.</p>
              <div className="relative">
                <Input
                  placeholder="Search account…"
                  value={basGstOpen ? basGstSearch : selectedAccountLabel(basGstAccountId)}
                  onFocus={() => { setBasGstOpen(true); setBasGstSearch('') }}
                  onBlur={() => setTimeout(() => setBasGstOpen(false), 150)}
                  onChange={e => setBasGstSearch(e.target.value)}
                  disabled={settingsLoading || settingsSaving}
                />
                {basGstOpen && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-52 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                    {basGstAccountId && (
                      <button type="button" onMouseDown={() => { setBasGstAccountId(''); setBasGstOpen(false) }}
                        className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 italic">
                        Clear selection
                      </button>
                    )}
                    {coaAccounts.filter(a => {
                      const q = basGstSearch.toLowerCase()
                      return !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || a.type.toLowerCase().includes(q)
                    }).map(a => (
                      <button key={a.id} type="button"
                        onMouseDown={() => { setBasGstAccountId(a.id); setBasGstOpen(false); setBasGstSearch('') }}
                        className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors', basGstAccountId === a.id && 'bg-primary/10 font-medium')}
                      >{a.code} — {a.name} <span className="text-xs text-muted-foreground ml-1">({a.type})</span></button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label>PAYG Income Tax Instalment Account</Label>
              <p className="text-xs text-muted-foreground">Receives the T7 PAYG Instalment component. Typically an Expense or Liability account.</p>
              <div className="relative">
                <Input
                  placeholder="Search account…"
                  value={basPaygOpen ? basPaygSearch : selectedAccountLabel(basPaygAccountId)}
                  onFocus={() => { setBasPaygOpen(true); setBasPaygSearch('') }}
                  onBlur={() => setTimeout(() => setBasPaygOpen(false), 150)}
                  onChange={e => setBasPaygSearch(e.target.value)}
                  disabled={settingsLoading || settingsSaving}
                />
                {basPaygOpen && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-52 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                    {basPaygAccountId && (
                      <button type="button" onMouseDown={() => { setBasPaygAccountId(''); setBasPaygOpen(false) }}
                        className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 italic">
                        Clear selection
                      </button>
                    )}
                    {coaAccounts.filter(a => {
                      const q = basPaygSearch.toLowerCase()
                      return !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || a.type.toLowerCase().includes(q)
                    }).map(a => (
                      <button key={a.id} type="button"
                        onMouseDown={() => { setBasPaygAccountId(a.id); setBasPaygOpen(false); setBasPaygSearch('') }}
                        className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors', basPaygAccountId === a.id && 'bg-primary/10 font-medium')}
                      >{a.code} — {a.name} <span className="text-xs text-muted-foreground ml-1">({a.type})</span></button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bas-payg-instalment-default">Default T7 Instalment Amount</Label>
              <p className="text-xs text-muted-foreground">Pre-fills T7 on new BAS periods and untouched editable periods until you save a period-specific amount.</p>
              <Input
                id="bas-payg-instalment-default"
                type="number"
                min="0"
                step="0.01"
                value={basPaygInstalmentDefault}
                onChange={e => setBasPaygInstalmentDefault(e.target.value)}
                placeholder="0.00"
                disabled={settingsLoading || settingsSaving}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bank Reconciliation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bank Reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            When reconciling a Stripe bank deposit, small differences between the bank deposit amount and the original Stripe invoice amount (up to $1.00) are automatically posted as a split to the account below. Typically a &ldquo;Bank Charges&rdquo; or &ldquo;Rounding&rdquo; expense account.
          </p>
          <div className="max-w-sm space-y-1">
            <Label>Stripe Rounding Account</Label>
            <p className="text-xs text-muted-foreground">Receives any rounding difference on Stripe bank-deposit reconciliations (e.g. Bank Charges, Rounding).</p>
            <div className="relative">
              <Input
                placeholder="Search account…"
                value={stripeRoundingOpen ? stripeRoundingSearch : selectedAccountLabel(stripeRoundingAccountId)}
                onFocus={() => { setStripeRoundingOpen(true); setStripeRoundingSearch('') }}
                onBlur={() => setTimeout(() => setStripeRoundingOpen(false), 150)}
                onChange={e => setStripeRoundingSearch(e.target.value)}
                disabled={settingsLoading || settingsSaving}
              />
              {stripeRoundingOpen && (
                <div className="absolute z-50 top-full left-0 right-0 mt-0.5 max-h-52 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                  {stripeRoundingAccountId && (
                    <button type="button" onMouseDown={() => { setStripeRoundingAccountId(''); setStripeRoundingOpen(false) }}
                      className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 italic">
                      Clear selection
                    </button>
                  )}
                  {coaAccounts.filter(a => {
                    const q = stripeRoundingSearch.toLowerCase()
                    return !q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || a.type.toLowerCase().includes(q)
                  }).map(a => (
                    <button key={a.id} type="button"
                      onMouseDown={() => { setStripeRoundingAccountId(a.id); setStripeRoundingOpen(false); setStripeRoundingSearch('') }}
                      className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors', stripeRoundingAccountId === a.id && 'bg-primary/10 font-medium')}
                    >{a.code} — {a.name} <span className="text-xs text-muted-foreground ml-1">({a.type})</span></button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      </div>
    </>
  )
}
