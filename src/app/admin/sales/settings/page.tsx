'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { getSalesSettings, saveSalesSettings } from '@/lib/sales/local-store'
import { apiFetch } from '@/lib/api-client'
import { pullAndHydrateSalesNativeStore } from '@/lib/sales/native-store-sync'

export default function SalesSettingsPage() {
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [qbBusy, setQbBusy] = useState(false)
  const [qbOutput, setQbOutput] = useState<string>('')
  const [qbLog, setQbLog] = useState<Array<{ ts: string; action: string; payload: any }>>([])
  const [qbLookbackDays, setQbLookbackDays] = useState('7')

  const [businessName, setBusinessName] = useState('')
  const [address, setAddress] = useState('')
  const [abn, setAbn] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [taxRatePercent, setTaxRatePercent] = useState('10')
  const [defaultQuoteValidDays, setDefaultQuoteValidDays] = useState('14')
  const [defaultInvoiceDueDays, setDefaultInvoiceDueDays] = useState('7')
  const [defaultTerms, setDefaultTerms] = useState('')
  const [paymentDetails, setPaymentDetails] = useState('')

  const [stripeLoaded, setStripeLoaded] = useState(false)
  const [stripeSaving, setStripeSaving] = useState(false)
  const [stripeSaved, setStripeSaved] = useState(false)

  const [stripeEnabled, setStripeEnabled] = useState(false)
  const [stripeLabel, setStripeLabel] = useState('')
  const [stripeFeePercent, setStripeFeePercent] = useState('1.7')
  const [stripePublishableKey, setStripePublishableKey] = useState('')
  const [stripeSecretKey, setStripeSecretKey] = useState('')
  const [stripeHasSecretKey, setStripeHasSecretKey] = useState(false)
  const [stripeSecretKeySource, setStripeSecretKeySource] = useState<'env' | 'db' | 'none'>('none')
  const [stripeDashboardPaymentDescription, setStripeDashboardPaymentDescription] = useState('Payment for Invoice {invoice_number}')
  const [stripeCurrencies, setStripeCurrencies] = useState('AUD')

  useEffect(() => {
    const s = getSalesSettings()
    setBusinessName(s.businessName)
    setAddress(s.address)
    setAbn(s.abn)
    setPhone(s.phone ?? '')
    setEmail(s.email ?? '')
    setWebsite(s.website ?? '')
    setTaxRatePercent(String(s.taxRatePercent))
    setDefaultQuoteValidDays(String(s.defaultQuoteValidDays ?? 14))
    setDefaultInvoiceDueDays(String(s.defaultInvoiceDueDays ?? 7))
    setDefaultTerms(s.defaultTerms)
    setPaymentDetails(s.paymentDetails)
    setLoaded(true)
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadStripe = async () => {
      try {
        const res = await apiFetch('/api/admin/sales/stripe', { method: 'GET' })
        const json = await res.json().catch(() => null)
        if (!res.ok) return

        if (cancelled) return

        setStripeEnabled(Boolean(json?.enabled))
        setStripeLabel(typeof json?.label === 'string' ? json.label : '')
        setStripeFeePercent(String(typeof json?.feePercent === 'number' ? json.feePercent : 1.7))
        setStripePublishableKey(typeof json?.publishableKey === 'string' ? json.publishableKey : '')
        setStripeDashboardPaymentDescription(
          typeof json?.dashboardPaymentDescription === 'string'
            ? json.dashboardPaymentDescription
            : 'Payment for Invoice {invoice_number}'
        )
        setStripeCurrencies(typeof json?.currencies === 'string' ? json.currencies : 'AUD')
        setStripeHasSecretKey(Boolean(json?.hasSecretKey))

        const src = typeof json?.secretKeySource === 'string' ? json.secretKeySource : 'none'
        setStripeSecretKeySource(src === 'env' || src === 'db' || src === 'none' ? src : 'none')
      } finally {
        if (!cancelled) setStripeLoaded(true)
      }
    }

    void loadStripe()
    return () => {
      cancelled = true
    }
  }, [])

  const runQuickBooksAction = async (label: string, url: string, method: 'GET' | 'POST') => {
    setQbBusy(true)
    setQbOutput('')
    try {
      const parsedLookback = Number(qbLookbackDays)
      const body = method === 'POST'
        ? JSON.stringify({ days: Number.isFinite(parsedLookback) ? parsedLookback : 7 })
        : undefined

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const json = await res.json().catch(() => null)

      const payload = {
        action: label,
        ok: res.ok,
        status: res.status,
        result: json,
      }

      // QBO imports now write native Sales docs to the server first.
      // After a successful pull, refresh this browser's local cache from the server.
      if (res.ok && method === 'POST' && (url.endsWith('/pull/quotes') || url.endsWith('/pull/invoices') || url.endsWith('/pull/payments'))) {
        const typeLabel = url.endsWith('/pull/quotes')
          ? 'quotes'
          : url.endsWith('/pull/invoices')
            ? 'invoices'
            : 'payments'

        payload.result = {
          ...payload.result,
          vitransfer: {
            ...(json?.vitransfer ?? {}),
            note: `Imported ${typeLabel} were saved to the server and synced down to this browser.`,
          },
        }

        try {
          const hydrated = await pullAndHydrateSalesNativeStore()
          payload.result = {
            ...payload.result,
            vitransfer: {
              ...(payload.result as any)?.vitransfer,
              localHydrate: hydrated,
            },
          }
        } catch (e) {
          payload.result = {
            ...payload.result,
            vitransfer: {
              ...(payload.result as any)?.vitransfer,
              localHydrate: { ok: false, error: e instanceof Error ? e.message : String(e) },
            },
          }
        }
      }

      setQbOutput(JSON.stringify(payload, null, 2))
      setQbLog((prev) => {
        const next = [{ ts: new Date().toISOString(), action: label, payload }, ...prev]
        return next.slice(0, 25)
      })
    } catch (e) {
      const payload = { action: label, ok: false, error: e instanceof Error ? e.message : String(e) }
      setQbOutput(JSON.stringify(payload, null, 2))
      setQbLog((prev) => {
        const next = [{ ts: new Date().toISOString(), action: label, payload }, ...prev]
        return next.slice(0, 25)
      })
    } finally {
      setQbBusy(false)
    }
  }

  const openQuickBooksAuthorize = async () => {
    setQbBusy(true)
    setQbOutput('')

    // Open immediately (avoids popup blockers), then set URL after we fetch it with auth.
    const popup = window.open('about:blank', 'qbo_oauth', 'width=600,height=720')
    if (!popup) {
      const payload = { action: 'Authorize', ok: false, error: 'Popup blocked. Please allow popups for this site.' }
      setQbOutput(JSON.stringify(payload, null, 2))
      setQbLog((prev) => {
        const next = [{ ts: new Date().toISOString(), action: 'Authorize', payload }, ...prev]
        return next.slice(0, 25)
      })
      setQbBusy(false)
      return
    }

    try {
      const res = await apiFetch('/api/sales/quickbooks/auth/start?json=1', { method: 'GET' })
      const json = await res.json().catch(() => null)

      const payload = {
        action: 'Authorize',
        ok: res.ok,
        status: res.status,
        result: json,
      }

      setQbOutput(JSON.stringify(payload, null, 2))
      setQbLog((prev) => {
        const next = [{ ts: new Date().toISOString(), action: 'Authorize', payload }, ...prev]
        return next.slice(0, 25)
      })

      const authorizeUrl = typeof json?.authorizeUrl === 'string' ? json.authorizeUrl : ''
      if (res.ok && authorizeUrl) {
        popup.location.href = authorizeUrl
      } else {
        popup.close()
      }
    } catch (e) {
      const payload = { action: 'Authorize', ok: false, error: e instanceof Error ? e.message : String(e) }
      setQbOutput(JSON.stringify(payload, null, 2))
      setQbLog((prev) => {
        const next = [{ ts: new Date().toISOString(), action: 'Authorize', payload }, ...prev]
        return next.slice(0, 25)
      })
      try {
        popup.close()
      } catch {
        // ignore
      }
    } finally {
      setQbBusy(false)
    }
  }

  const onSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const parsedTax = Number(taxRatePercent)
      const parsedQuoteDays = Number(defaultQuoteValidDays)
      const parsedInvoiceDays = Number(defaultInvoiceDueDays)
      saveSalesSettings({
        businessName,
        address,
        abn,
        phone,
        email,
        website,
        taxRatePercent: Number.isFinite(parsedTax) ? parsedTax : 0,
        defaultQuoteValidDays: Number.isFinite(parsedQuoteDays) ? parsedQuoteDays : 14,
        defaultInvoiceDueDays: Number.isFinite(parsedInvoiceDays) ? parsedInvoiceDays : 7,
        defaultTerms,
        paymentDetails,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  const onSaveStripe = async () => {
    if (stripeSaving) return
    setStripeSaving(true)
    setStripeSaved(false)
    try {
      const parsedFee = Number(stripeFeePercent)

      const res = await apiFetch('/api/admin/sales/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: stripeEnabled,
          label: stripeLabel,
          feePercent: Number.isFinite(parsedFee) ? parsedFee : 0,
          publishableKey: stripePublishableKey || null,
          secretKey: stripeSecretKey || null,
          dashboardPaymentDescription: stripeDashboardPaymentDescription,
          currencies: stripeCurrencies,
        }),
      })

      const json = await res.json().catch(() => null)
      if (!res.ok) {
        const message = typeof json?.error === 'string' ? json.error : 'Unable to save Stripe settings'
        alert(message)
        return
      }

      setStripeEnabled(Boolean(json?.enabled))
      setStripeLabel(typeof json?.label === 'string' ? json.label : stripeLabel)
      setStripeFeePercent(String(typeof json?.feePercent === 'number' ? json.feePercent : parsedFee))
      setStripePublishableKey(typeof json?.publishableKey === 'string' ? json.publishableKey : stripePublishableKey)
      setStripeDashboardPaymentDescription(
        typeof json?.dashboardPaymentDescription === 'string'
          ? json.dashboardPaymentDescription
          : stripeDashboardPaymentDescription
      )
      setStripeCurrencies(typeof json?.currencies === 'string' ? json.currencies : stripeCurrencies)
      setStripeHasSecretKey(Boolean(json?.hasSecretKey))

      const src = typeof json?.secretKeySource === 'string' ? json.secretKeySource : stripeSecretKeySource
      setStripeSecretKeySource(src === 'env' || src === 'db' || src === 'none' ? src : stripeSecretKeySource)

      // Never keep secret in memory longer than necessary.
      setStripeSecretKey('')

      setStripeSaved(true)
      setTimeout(() => setStripeSaved(false), 1500)
    } finally {
      setStripeSaving(false)
    }
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">Loading settings…</div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Sales settings</h2>
        <p className="text-sm text-muted-foreground">Defaults used when creating quotes and invoices.</p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-6">
          <div className="space-y-2">
            <Label>Business name</Label>
            <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className="h-9" />
          </div>

          <div className="space-y-2">
            <Label>ABN</Label>
            <Input value={abn} onChange={(e) => setAbn(e.target.value)} className="h-9" />
          </div>

          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" placeholder="accounts@" />
          </div>

          <div className="space-y-2">
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9" />
          </div>

          <div className="md:col-span-2 space-y-2">
            <Label>Website</Label>
            <Input value={website} onChange={(e) => setWebsite(e.target.value)} className="h-9" placeholder="https://" />
          </div>

          <div className="md:col-span-2 space-y-2">
            <Label>Address</Label>
            <Textarea value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street\nSuburb State Postcode" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Tax rate (%)</Label>
              <Input value={taxRatePercent} onChange={(e) => setTaxRatePercent(e.target.value)} className="h-9" />
              <p className="text-xs text-muted-foreground">Used to calculate totals (e.g. GST).</p>
            </div>

            <div className="space-y-2">
              <Label>Default quote validity (days)</Label>
              <Input
                value={defaultQuoteValidDays}
                onChange={(e) => setDefaultQuoteValidDays(e.target.value)}
                className="h-9"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">Used to prefill “Valid until”.</p>
            </div>

            <div className="space-y-2">
              <Label>Default invoice due (days)</Label>
              <Input
                value={defaultInvoiceDueDays}
                onChange={(e) => setDefaultInvoiceDueDays(e.target.value)}
                className="h-9"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">Used to prefill “Due date”.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Payment details</Label>
              <Textarea value={paymentDetails} onChange={(e) => setPaymentDetails(e.target.value)} placeholder="BSB / Account / PayID / etc" />
            </div>

            <div className="space-y-2">
              <Label>Default T&Cs</Label>
              <Textarea value={defaultTerms} onChange={(e) => setDefaultTerms(e.target.value)} />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            {saved && <div className="text-sm text-emerald-600 dark:text-emerald-400 self-center">Saved</div>}
            <Button onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stripe Checkout</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!stripeLoaded ? (
            <div className="text-sm text-muted-foreground">Loading Stripe settings…</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">Enable Stripe payments</div>
                  <div className="text-xs text-muted-foreground">Shows “Pay Invoice” on public invoice pages.</div>
                </div>
                <Switch checked={stripeEnabled} onCheckedChange={setStripeEnabled} />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>Label (shown under Pay Invoice button)</Label>
                  <Input
                    value={stripeLabel}
                    onChange={(e) => setStripeLabel(e.target.value)}
                    className="h-9"
                    placeholder="Pay by Credit Card (attracts merchant fees of 1.70%)"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Percentage fee (%)</Label>
                  <Input
                    value={stripeFeePercent}
                    onChange={(e) => setStripeFeePercent(e.target.value)}
                    className="h-9"
                    inputMode="decimal"
                  />
                  <p className="text-xs text-muted-foreground">Added on top of the invoice total for Stripe payments.</p>
                </div>

                <div className="space-y-2">
                  <Label>Currencies (comma separated)</Label>
                  <Input
                    value={stripeCurrencies}
                    onChange={(e) => setStripeCurrencies(e.target.value)}
                    className="h-9"
                    placeholder="AUD, NZD"
                  />
                  <p className="text-xs text-muted-foreground">First currency is used for invoice payments.</p>
                </div>

                <div className="space-y-2">
                  <Label>Stripe Publishable Key</Label>
                  <Input
                    value={stripePublishableKey}
                    onChange={(e) => setStripePublishableKey(e.target.value)}
                    className="h-9"
                    placeholder="pk_live_…"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Stripe API Secret Key</Label>
                  <Input
                    value={stripeSecretKey}
                    onChange={(e) => setStripeSecretKey(e.target.value)}
                    className="h-9"
                    type="password"
                    placeholder={stripeHasSecretKey ? '•••••••• (configured)' : 'sk_live_…'}
                  />
                  <p className="text-xs text-muted-foreground">
                    Stored encrypted in Postgres. If `STRIPE_SECRET_KEY` is set in the environment, it takes precedence.
                    Current source: <span className="font-medium">{stripeSecretKeySource}</span>
                  </p>
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label>Gateway Dashboard Payment Description</Label>
                  <Input
                    value={stripeDashboardPaymentDescription}
                    onChange={(e) => setStripeDashboardPaymentDescription(e.target.value)}
                    className="h-9"
                    placeholder="Payment for Invoice {invoice_number}"
                  />
                  <p className="text-xs text-muted-foreground">Supports: {`{invoice_number}`}</p>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                {stripeSaved && <div className="text-sm text-emerald-600 dark:text-emerald-400 self-center">Saved</div>}
                <Button onClick={() => void onSaveStripe()} disabled={stripeSaving}>
                  {stripeSaving ? 'Saving…' : 'Save Stripe settings'}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">QuickBooks Integration (Pull only)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground space-y-1">
            <p>
              This integration is read-only: ViTransfer will never create/update anything in QuickBooks.
            </p>
            <p>
              Pulling quotes/invoices will ingest them into the main Sales tables automatically.
            </p>
            <p>
              Note: Intuit refresh tokens can rotate. ViTransfer will automatically persist the latest refresh token (encrypted) in Postgres when you run pulls or the daily worker refresh job.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-2 sm:col-span-1">
              <Label>Lookback (days)</Label>
              <Input
                value={qbLookbackDays}
                onChange={(e) => setQbLookbackDays(e.target.value)}
                className="h-9"
                inputMode="numeric"
              />
            </div>

            <div className="flex flex-wrap gap-2 sm:col-span-2 items-end">
            <Button
              type="button"
              variant="outline"
              disabled={qbBusy}
              onClick={() => void openQuickBooksAuthorize()}
            >
              Authorize
            </Button>

            <Button
              type="button"
              variant="secondary"
              disabled={qbBusy}
              onClick={() => runQuickBooksAction('Health', '/api/sales/quickbooks/health', 'GET')}
            >
              {qbBusy ? 'Working…' : 'Test connection'}
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={qbBusy}
              onClick={() => runQuickBooksAction('Pull Clients', '/api/sales/quickbooks/pull/customers', 'POST')}
            >
              Pull Clients
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={qbBusy}
              onClick={() => runQuickBooksAction('Pull Quotes (store)', '/api/sales/quickbooks/pull/quotes', 'POST')}
            >
              Pull Quotes
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={qbBusy}
              onClick={() => runQuickBooksAction('Pull Invoices (store)', '/api/sales/quickbooks/pull/invoices', 'POST')}
            >
              Pull Invoices
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={qbBusy}
              onClick={() => runQuickBooksAction('Pull Payments (store)', '/api/sales/quickbooks/pull/payments', 'POST')}
            >
              Pull Payments
            </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">Latest result</div>
              {qbLog.length > 0 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setQbLog([])} disabled={qbBusy}>
                  Clear log
                </Button>
              )}
            </div>

            {qbOutput ? (
              <pre className="max-h-[240px] overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
                {qbOutput}
              </pre>
            ) : (
              <div className="text-xs text-muted-foreground">Results will appear here.</div>
            )}

            {qbLog.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">Run history</div>
                <div className="max-h-[260px] overflow-auto rounded-md border border-border bg-muted/20">
                  {qbLog.map((entry, idx) => (
                    <div key={entry.ts + '-' + idx} className="border-b border-border/50 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-medium">{entry.action}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">{entry.ts}</div>
                      </div>
                      <pre className="mt-2 text-xs overflow-auto">{JSON.stringify(entry.payload, null, 2)}</pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
