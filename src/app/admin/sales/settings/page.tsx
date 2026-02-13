'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { fetchSalesSettings, saveSalesSettings as saveSalesSettingsApi } from '@/lib/sales/admin-api'
import { apiFetch } from '@/lib/api-client'
import { formatDateTime } from '@/lib/utils'

export default function SalesSettingsPage() {
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [qbBusy, setQbBusy] = useState(false)
  const [qbLoaded, setQbLoaded] = useState(false)
  const [qbSaving, setQbSaving] = useState(false)
  const [qbSaved, setQbSaved] = useState(false)

  const [qbDailyPullEnabled, setQbDailyPullEnabled] = useState(true)
  const [qbDailyPullTime, setQbDailyPullTime] = useState('21:00')
  const [qbLookbackDays, setQbLookbackDays] = useState('7')
  const [qbLastAttempt, setQbLastAttempt] = useState<null | {
    attemptedAt: string | null
    succeeded: boolean | null
    message: string | null
  }>(null)
  const [qbManualStatus, setQbManualStatus] = useState<string>('')

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
  const [stripeFeeFixed, setStripeFeeFixed] = useState('0.30')
  const [stripePublishableKey, setStripePublishableKey] = useState('')
  const [stripeSecretKey, setStripeSecretKey] = useState('')
  const [stripeHasSecretKey, setStripeHasSecretKey] = useState(false)
  const [stripeSecretKeySource, setStripeSecretKeySource] = useState<'env' | 'db' | 'none'>('none')
  const [stripeDashboardPaymentDescription, setStripeDashboardPaymentDescription] = useState('Payment for Invoice {invoice_number}')
  const [stripeCurrencies, setStripeCurrencies] = useState('AUD')

  const [remindersLoaded, setRemindersLoaded] = useState(false)
  const [remindersSaving, setRemindersSaving] = useState(false)
  const [remindersSaved, setRemindersSaved] = useState(false)

  const [overdueInvoiceRemindersEnabled, setOverdueInvoiceRemindersEnabled] = useState(false)
  const [overdueInvoiceBusinessDaysAfterDue, setOverdueInvoiceBusinessDaysAfterDue] = useState('3')
  const [quoteExpiryRemindersEnabled, setQuoteExpiryRemindersEnabled] = useState(false)
  const [quoteExpiryBusinessDaysBeforeValidUntil, setQuoteExpiryBusinessDaysBeforeValidUntil] = useState('3')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await fetchSalesSettings()
        if (cancelled) return

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
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()

    return () => {
      cancelled = true
    }
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
        setStripeFeeFixed(
          String(
            typeof json?.feeFixedCents === 'number'
              ? (Math.max(0, Math.trunc(json.feeFixedCents)) / 100).toFixed(2)
              : '0.30'
          )
        )
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

  useEffect(() => {
    let cancelled = false

    const loadReminders = async () => {
      try {
        const res = await apiFetch('/api/admin/sales/reminder-settings', { method: 'GET' })
        const json = await res.json().catch(() => null)
        if (!res.ok) return
        if (cancelled) return

        setOverdueInvoiceRemindersEnabled(Boolean(json?.overdueInvoiceRemindersEnabled))
        setOverdueInvoiceBusinessDaysAfterDue(String(typeof json?.overdueInvoiceBusinessDaysAfterDue === 'number' ? json.overdueInvoiceBusinessDaysAfterDue : 3))
        setQuoteExpiryRemindersEnabled(Boolean(json?.quoteExpiryRemindersEnabled))
        setQuoteExpiryBusinessDaysBeforeValidUntil(String(typeof json?.quoteExpiryBusinessDaysBeforeValidUntil === 'number' ? json.quoteExpiryBusinessDaysBeforeValidUntil : 3))
      } finally {
        if (!cancelled) setRemindersLoaded(true)
      }
    }

    void loadReminders()
    return () => {
      cancelled = true
    }
  }, [])

  const onSaveReminders = async () => {
    setRemindersSaving(true)
    setRemindersSaved(false)
    try {
      const parsedOverdue = Math.trunc(Number(overdueInvoiceBusinessDaysAfterDue))
      const parsedExpiry = Math.trunc(Number(quoteExpiryBusinessDaysBeforeValidUntil))

      const body = {
        overdueInvoiceRemindersEnabled,
        overdueInvoiceBusinessDaysAfterDue: Number.isFinite(parsedOverdue) ? Math.max(1, parsedOverdue) : 3,
        quoteExpiryRemindersEnabled,
        quoteExpiryBusinessDaysBeforeValidUntil: Number.isFinite(parsedExpiry) ? Math.max(1, parsedExpiry) : 3,
      }

      const res = await apiFetch('/api/admin/sales/reminder-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        alert(typeof json?.error === 'string' ? json.error : 'Failed to save Sales Notifications settings')
        return
      }

      setOverdueInvoiceRemindersEnabled(Boolean(json?.overdueInvoiceRemindersEnabled))
      setOverdueInvoiceBusinessDaysAfterDue(String(typeof json?.overdueInvoiceBusinessDaysAfterDue === 'number' ? json.overdueInvoiceBusinessDaysAfterDue : body.overdueInvoiceBusinessDaysAfterDue))
      setQuoteExpiryRemindersEnabled(Boolean(json?.quoteExpiryRemindersEnabled))
      setQuoteExpiryBusinessDaysBeforeValidUntil(String(typeof json?.quoteExpiryBusinessDaysBeforeValidUntil === 'number' ? json.quoteExpiryBusinessDaysBeforeValidUntil : body.quoteExpiryBusinessDaysBeforeValidUntil))

      setRemindersSaved(true)
      setTimeout(() => setRemindersSaved(false), 2000)
    } finally {
      setRemindersSaving(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const loadQb = async () => {
      try {
        const res = await apiFetch('/api/sales/quickbooks/settings', { method: 'GET' })
        const json = await res.json().catch(() => null)
        if (!res.ok) return

        if (cancelled) return

        setQbDailyPullEnabled(Boolean(json?.dailyPullEnabled))
        setQbDailyPullTime(typeof json?.dailyPullTime === 'string' ? json.dailyPullTime : '21:00')
        setQbLookbackDays(String(typeof json?.pullLookbackDays === 'number' ? json.pullLookbackDays : 7))
        setQbLastAttempt({
          attemptedAt: typeof json?.lastDailyPullAttemptAt === 'string' ? json.lastDailyPullAttemptAt : null,
          succeeded: typeof json?.lastDailyPullSucceeded === 'boolean' ? json.lastDailyPullSucceeded : null,
          message: typeof json?.lastDailyPullMessage === 'string' ? json.lastDailyPullMessage : null,
        })
      } finally {
        if (!cancelled) setQbLoaded(true)
      }
    }

    void loadQb()
    return () => {
      cancelled = true
    }
  }, [])

  const runQuickBooksAction = async (label: string, url: string, method: 'GET' | 'POST') => {
    setQbBusy(true)
    setQbSaved(false)
    setQbManualStatus('')
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

      const summarySuffix = (() => {
        const stored = (json as any)?.stored
        const created = stored && typeof stored?.created === 'number' ? stored.created : (typeof (json as any)?.created === 'number' ? (json as any).created : null)
        const updatedRaw = stored && typeof stored?.updated === 'number' ? stored.updated : (typeof (json as any)?.updated === 'number' ? (json as any).updated : null)
        const skipped = stored && typeof stored?.skipped === 'number' ? stored.skipped : (typeof (json as any)?.skipped === 'number' ? (json as any).skipped : null)

        if (created === null || updatedRaw === null || skipped === null) return ''

        // Customer pulls report linked-by-name separately; treat that as an update for the concise summary.
        const linkedByName = typeof (json as any)?.linkedByName === 'number' ? (json as any).linkedByName : 0
        const updated = updatedRaw + linkedByName
        return ` (c=${created},u=${updated},s=${skipped})`
      })()

      if (res.ok) {
        setQbManualStatus(`${label} completed${summarySuffix}.`)
      } else {
        const err = typeof (json as any)?.error === 'string' ? (json as any).error : null
        setQbManualStatus(err ? `${label} failed: ${err}` : `${label} failed (${res.status}).`)
      }

      // Refresh daily pull summary (single last attempt) after any successful action.
      if (res.ok) {
        try {
          const sres = await apiFetch('/api/sales/quickbooks/settings', { method: 'GET' })
          const sj = await sres.json().catch(() => null)
          if (sres.ok) {
            setQbLastAttempt({
              attemptedAt: typeof sj?.lastDailyPullAttemptAt === 'string' ? sj.lastDailyPullAttemptAt : null,
              succeeded: typeof sj?.lastDailyPullSucceeded === 'boolean' ? sj.lastDailyPullSucceeded : null,
              message: typeof sj?.lastDailyPullMessage === 'string' ? sj.lastDailyPullMessage : null,
            })
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      setQbManualStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setQbBusy(false)
    }
  }

  const onSaveQuickBooks = async () => {
    setQbSaving(true)
    setQbSaved(false)
    setQbManualStatus('')
    try {
      const parsedLookback = Number(qbLookbackDays)
      const body = {
        dailyPullEnabled: qbDailyPullEnabled,
        dailyPullTime: qbDailyPullTime,
        pullLookbackDays: Number.isFinite(parsedLookback) ? parsedLookback : 7,
      }

      const res = await apiFetch('/api/sales/quickbooks/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setQbManualStatus(typeof json?.error === 'string' ? json.error : 'Failed to save QuickBooks settings')
        return
      }

      setQbDailyPullEnabled(Boolean(json?.dailyPullEnabled))
      setQbDailyPullTime(typeof json?.dailyPullTime === 'string' ? json.dailyPullTime : qbDailyPullTime)
      setQbLookbackDays(String(typeof json?.pullLookbackDays === 'number' ? json.pullLookbackDays : Number(qbLookbackDays)))
      setQbLastAttempt({
        attemptedAt: typeof json?.lastDailyPullAttemptAt === 'string' ? json.lastDailyPullAttemptAt : null,
        succeeded: typeof json?.lastDailyPullSucceeded === 'boolean' ? json.lastDailyPullSucceeded : null,
        message: typeof json?.lastDailyPullMessage === 'string' ? json.lastDailyPullMessage : null,
      })

      setQbSaved(true)
      setTimeout(() => setQbSaved(false), 2000)
    } catch (e) {
      setQbManualStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setQbSaving(false)
    }
  }

  const openQuickBooksAuthorize = async () => {
    setQbBusy(true)
    setQbManualStatus('')

    // Open immediately (avoids popup blockers), then set URL after we fetch it with auth.
    const popup = window.open('about:blank', 'qbo_oauth', 'width=600,height=720')
    if (!popup) {
      setQbManualStatus('Authorize failed: Popup blocked. Please allow popups for this site.')
      setQbBusy(false)
      return
    }

    try {
      const res = await apiFetch('/api/sales/quickbooks/auth/start?json=1', { method: 'GET' })
      const json = await res.json().catch(() => null)

      const authorizeUrl = typeof json?.authorizeUrl === 'string' ? json.authorizeUrl : ''
      if (res.ok && authorizeUrl) {
        popup.location.href = authorizeUrl
        setQbManualStatus('Authorize started (popup opened).')
      } else {
        popup.close()
        setQbManualStatus('Authorize failed: could not start OAuth flow.')
      }
    } catch (e) {
      setQbManualStatus(`Authorize failed: ${e instanceof Error ? e.message : String(e)}`)
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

      await saveSalesSettingsApi({
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
        updatedAt: new Date().toISOString(),
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
      const parsedFixed = Number(stripeFeeFixed)
      const feeFixedCents = Number.isFinite(parsedFixed) ? Math.max(0, Math.round(parsedFixed * 100)) : 0

      const res = await apiFetch('/api/admin/sales/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: stripeEnabled,
          label: stripeLabel,
          feePercent: Number.isFinite(parsedFee) ? parsedFee : 0,
          feeFixedCents,
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
      setStripeFeeFixed(
        String(
          typeof json?.feeFixedCents === 'number'
            ? (Math.max(0, Math.trunc(json.feeFixedCents)) / 100).toFixed(2)
            : (feeFixedCents / 100).toFixed(2)
        )
      )
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
          <CardTitle className="text-base">Sales Notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!remindersLoaded ? (
            <div className="text-sm text-muted-foreground">Loading Sales Notifications settings…</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label>Overdue invoice reminders</Label>
                      <p className="text-xs text-muted-foreground mt-1">
                        Sends reminder emails to client recipients marked with the green $ icon.
                      </p>
                    </div>
                    <Switch checked={overdueInvoiceRemindersEnabled} onCheckedChange={setOverdueInvoiceRemindersEnabled} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Business days after due</Label>
                  <Input
                    value={overdueInvoiceBusinessDaysAfterDue}
                    onChange={(e) => setOverdueInvoiceBusinessDaysAfterDue(e.target.value)}
                    className="h-9"
                    inputMode="numeric"
                    disabled={!overdueInvoiceRemindersEnabled}
                  />
                  <p className="text-xs text-muted-foreground">Runs at 9am weekdays (server/container time).</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label>Quote expiry reminders</Label>
                      <p className="text-xs text-muted-foreground mt-1">
                        Sends reminder emails for quotes nearing “Valid until”.
                      </p>
                    </div>
                    <Switch checked={quoteExpiryRemindersEnabled} onCheckedChange={setQuoteExpiryRemindersEnabled} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Business days before valid-until</Label>
                  <Input
                    value={quoteExpiryBusinessDaysBeforeValidUntil}
                    onChange={(e) => setQuoteExpiryBusinessDaysBeforeValidUntil(e.target.value)}
                    className="h-9"
                    inputMode="numeric"
                    disabled={!quoteExpiryRemindersEnabled}
                  />
                  <p className="text-xs text-muted-foreground">Runs at 9am weekdays (server/container time).</p>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                {remindersSaved && <div className="text-sm text-emerald-600 dark:text-emerald-400 self-center">Saved</div>}
                <Button onClick={onSaveReminders} disabled={remindersSaving}>
                  {remindersSaving ? 'Saving…' : 'Save notifications'}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-base">Stripe Checkout</CardTitle>
          <Switch checked={stripeEnabled} onCheckedChange={setStripeEnabled} disabled={!stripeLoaded} />
        </CardHeader>
        <CardContent className="space-y-4">
          {!stripeLoaded ? (
            <div className="text-sm text-muted-foreground">Loading Stripe settings…</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>Label (shown under Pay Invoice button)</Label>
                  <Input
                    value={stripeLabel}
                    onChange={(e) => setStripeLabel(e.target.value)}
                    className="h-9"
                    placeholder="Pay by Credit Card (card processing fee applies)"
                  />
                </div>

                <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Percentage fee (%)</Label>
                    <Input
                      value={stripeFeePercent}
                      onChange={(e) => setStripeFeePercent(e.target.value)}
                      className="h-9"
                      inputMode="decimal"
                    />
                    <p className="text-xs text-muted-foreground">Used to calculate a gross-up so your net matches the invoice total.</p>
                  </div>

                  <div className="space-y-2">
                    <Label>Fixed fee (A$)</Label>
                    <Input
                      value={stripeFeeFixed}
                      onChange={(e) => setStripeFeeFixed(e.target.value)}
                      className="h-9"
                      inputMode="decimal"
                      placeholder="0.30"
                    />
                    <p className="text-xs text-muted-foreground">Flat Stripe processing fee per successful charge.</p>
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
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-base">QuickBooks Integration (Pull only)</CardTitle>
          <Switch checked={qbDailyPullEnabled} onCheckedChange={setQbDailyPullEnabled} disabled={!qbLoaded || qbBusy || qbSaving} />
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

          {!qbLoaded ? (
            <div className="text-sm text-muted-foreground">Loading QuickBooks settings…</div>
          ) : (
            <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-2 sm:col-span-1">
                <Label>Daily pull task</Label>
                <Input
                  type="time"
                  value={qbDailyPullTime}
                  onChange={(e) => setQbDailyPullTime(e.target.value)}
                  className="h-9"
                  disabled={!qbDailyPullEnabled || qbBusy || qbSaving}
                />
              </div>

              <div className="space-y-2 sm:col-span-1">
                <Label>Lookback (days)</Label>
                <Input
                  value={qbLookbackDays}
                  onChange={(e) => setQbLookbackDays(e.target.value)}
                  className="h-9"
                  inputMode="numeric"
                  disabled={qbBusy || qbSaving}
                />
              </div>

              <div className="flex flex-wrap gap-2 sm:col-span-1 items-end justify-end">
                {qbSaved && <div className="text-sm text-emerald-600 dark:text-emerald-400 self-center">Saved</div>}
                <Button onClick={() => void onSaveQuickBooks()} disabled={qbBusy || qbSaving}>
                  {qbSaving ? 'Saving…' : 'Save QuickBooks settings'}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-end">
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

            <div className="space-y-1">
              {qbManualStatus && <div className="text-xs text-muted-foreground">{qbManualStatus}</div>}
              <div className="text-xs text-muted-foreground">Daily pull summary</div>
              {!qbLastAttempt?.attemptedAt ? (
                <div className="text-xs text-muted-foreground">No attempts yet.</div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(qbLastAttempt.attemptedAt)} — {qbLastAttempt.succeeded ? 'Success' : 'Error'}
                  {qbLastAttempt.message ? ` — ${qbLastAttempt.message}` : ''}
                </div>
              )}
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
