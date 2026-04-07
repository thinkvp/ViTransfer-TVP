'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { fetchSalesSettings, saveSalesSettings as saveSalesSettingsApi, fetchTaxRates, saveTaxRatesBulk, listSalesLabels, createSalesLabel, updateSalesLabel, deleteSalesLabel } from '@/lib/sales/admin-api'
import type { SalesTaxRate } from '@/lib/sales/types'
import type { SalesLabel } from '@/lib/sales/admin-api'
import { apiFetch } from '@/lib/api-client'
import { formatDateTime, cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BarChart3, Bell, Building2, CreditCard, Link2, Pencil, Plus, ReceiptText, Save, Star, Tag, Trash2 } from 'lucide-react'
import { getCurrencySymbol } from '@/lib/sales/currency'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

const SALES_SECTIONS = [
  { id: 'sales-details', label: 'Sales Details', icon: Building2 },
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  { id: 'tax', label: 'Tax', icon: ReceiptText },
  { id: 'labels', label: 'Labels', icon: Tag },
  { id: 'sales-notifications', label: 'Sales Notifications', icon: Bell },
  { id: 'stripe-checkout', label: 'Stripe Checkout', icon: CreditCard },
  { id: 'quickbooks', label: 'Quickbooks Integration', icon: Link2 },
] as const

type SalesSection = typeof SALES_SECTIONS[number]['id']

const DEFAULT_INCOME_ACCOUNT_VALUE = '__DEFAULT_INCOME_ACCOUNT__'
const NO_LABEL_ACCOUNT_VALUE = '__NO_LABEL_ACCOUNT__'

export default function SalesSettingsPage() {
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [activeSection, setActiveSection] = useState<SalesSection>('sales-details')
  const [universalSaving, setUniversalSaving] = useState(false)
  const [universalSuccess, setUniversalSuccess] = useState(false)

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
  const [businessRegistrationLabel, setBusinessRegistrationLabel] = useState('ABN')
  const [currencyCode, setCurrencyCode] = useState('AUD')
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState('7')
  const [quoteLabel, setQuoteLabel] = useState('QUOTE')
  const [invoiceLabel, setInvoiceLabel] = useState('INVOICE')
  const [taxLabel, setTaxLabel] = useState('')
  const [taxEnabled, setTaxEnabled] = useState(true)
  const [taxRatePercent, setTaxRatePercent] = useState('10')
  const [defaultQuoteValidDays, setDefaultQuoteValidDays] = useState('14')
  const [defaultInvoiceDueDays, setDefaultInvoiceDueDays] = useState('7')
  const [defaultTerms, setDefaultTerms] = useState('')
  const [paymentDetails, setPaymentDetails] = useState('')
  const [dashboardReportingBasis, setDashboardReportingBasis] = useState<'CASH' | 'ACCRUAL'>('ACCRUAL')
  const [dashboardAmountsIncludeGst, setDashboardAmountsIncludeGst] = useState(true)

  // Tax rate add/edit modal
  const [taxRateModalOpen, setTaxRateModalOpen] = useState(false)
  const [taxRateModalSaving, setTaxRateModalSaving] = useState(false)
  const [editingRate, setEditingRate] = useState<{ id?: string; name: string; rate: string } | null>(null)
  const [taxRates, setTaxRates] = useState<SalesTaxRate[]>([])
  const [taxRatesLoaded, setTaxRatesLoaded] = useState(false)
  const [taxRatesBusy, setTaxRatesBusy] = useState(false)

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

  // Labels state
  const [labels, setLabels] = useState<SalesLabel[]>([])
  const [labelsLoaded, setLabelsLoaded] = useState(false)
  const [incomeAccounts, setIncomeAccounts] = useState<Array<{ id: string; code: string; name: string }>>([])  
  const [defaultIncomeAccountId, setDefaultIncomeAccountId] = useState<string>('')
  const [labelModalOpen, setLabelModalOpen] = useState(false)
  const [labelModalSaving, setLabelModalSaving] = useState(false)
  const [editingLabel, setEditingLabel] = useState<SalesLabel | null>(null)
  const [labelFormName, setLabelFormName] = useState('')
  const [labelFormColor, setLabelFormColor] = useState('#6366F1')
  const [labelFormAccountId, setLabelFormAccountId] = useState<string>('')
  const [labelFormError, setLabelFormError] = useState<string | null>(null)

  // Unsaved changes tracking
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const settingsSnapshot = JSON.stringify({
    businessName, address, abn, phone, email, website,
    businessRegistrationLabel, currencyCode, fiscalYearStartMonth,
    quoteLabel, invoiceLabel, taxLabel, taxEnabled, taxRatePercent,
    dashboardReportingBasis, dashboardAmountsIncludeGst,
    defaultQuoteValidDays, defaultInvoiceDueDays, defaultTerms, paymentDetails, defaultIncomeAccountId,
    stripeEnabled, stripeLabel, stripeFeePercent, stripeFeeFixed,
    stripePublishableKey, stripeSecretKey, stripeDashboardPaymentDescription, stripeCurrencies,
    qbDailyPullEnabled, qbDailyPullTime, qbLookbackDays,
    overdueInvoiceRemindersEnabled, overdueInvoiceBusinessDaysAfterDue,
    quoteExpiryRemindersEnabled, quoteExpiryBusinessDaysBeforeValidUntil,
  })
  const hasUnsavedChanges = loaded && savedSnapshot !== '' && settingsSnapshot !== savedSnapshot
  useUnsavedChanges(hasUnsavedChanges)

  useEffect(() => {
    if (loaded && savedSnapshot === '') {
      setSavedSnapshot(settingsSnapshot)
    }
  }, [loaded, savedSnapshot, settingsSnapshot])

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
        setBusinessRegistrationLabel(s.businessRegistrationLabel || 'ABN')
        setCurrencyCode(s.currencyCode || 'AUD')
        setFiscalYearStartMonth(String(s.fiscalYearStartMonth ?? 7))
        setQuoteLabel(s.quoteLabel || 'QUOTE')
        setInvoiceLabel(s.invoiceLabel || 'INVOICE')
        setTaxLabel(s.taxLabel || '')
        setTaxEnabled(typeof s.taxEnabled === 'boolean' ? s.taxEnabled : true)
        setTaxRatePercent(String(s.taxRatePercent))
        setDashboardReportingBasis(s.dashboardReportingBasis === 'CASH' ? 'CASH' : 'ACCRUAL')
        setDashboardAmountsIncludeGst(s.dashboardAmountsIncludeGst !== false)
        setDefaultQuoteValidDays(String(s.defaultQuoteValidDays ?? 14))
        setDefaultInvoiceDueDays(String(s.defaultInvoiceDueDays ?? 7))
        setDefaultTerms(s.defaultTerms)
        setPaymentDetails(s.paymentDetails)
        setDefaultIncomeAccountId(s.defaultIncomeAccountId ?? '')

        // Load tax rates
        try {
          const rates = await fetchTaxRates()
          if (!cancelled) setTaxRates(rates)
        } catch { /* ignore */ }
        if (!cancelled) setTaxRatesLoaded(true)
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

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [lbls, accountRes] = await Promise.all([
          listSalesLabels(),
          apiFetch('/api/admin/accounting/accounts?type=INCOME&activeOnly=true'),
        ])
        if (cancelled) return
        setLabels(lbls)
        const accJson = await accountRes.json().catch(() => null)
        const accs = Array.isArray(accJson?.accounts) ? accJson.accounts : []
        setIncomeAccounts(accs.map((a: any) => ({ id: a.id, code: a.code ?? '', name: a.name ?? '' })))
      } catch {
        // ignore; labels section will still render empty
      } finally {
        if (!cancelled) setLabelsLoaded(true)
      }
    })()
    return () => { cancelled = true }
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

  async function handleSaveLabel() {
    const name = labelFormName.trim()
    if (!name) return
    setLabelModalSaving(true)
    setLabelFormError(null)
    try {
      if (editingLabel) {
        const updated = await updateSalesLabel(editingLabel.id, {
          name,
          color: labelFormColor || null,
          accountId: labelFormAccountId || null,
        })
        setLabels((prev) => prev.map((x) => (x.id === editingLabel.id ? updated : x)))
      } else {
        const created = await createSalesLabel({
          name,
          color: labelFormColor || null,
          accountId: labelFormAccountId || null,
          isActive: true,
          sortOrder: labels.length,
        })
        setLabels((prev) => [...prev, created])
      }
      setLabelModalOpen(false)
    } catch (e) {
      setLabelFormError(e instanceof Error ? e.message : 'Failed to save label')
    } finally {
      setLabelModalSaving(false)
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

      const parsedFyMonth = Number(fiscalYearStartMonth)
      const fyMonth = Number.isFinite(parsedFyMonth) && parsedFyMonth >= 1 && parsedFyMonth <= 12 ? parsedFyMonth : 7

      await saveSalesSettingsApi({
        businessName,
        address,
        abn,
        phone,
        email,
        website,
        businessRegistrationLabel: businessRegistrationLabel.trim() || 'ABN',
        currencyCode: currencyCode.trim() || 'AUD',
        fiscalYearStartMonth: fyMonth,
        quoteLabel: quoteLabel.trim() || 'QUOTE',
        invoiceLabel: invoiceLabel.trim() || 'INVOICE',
        taxLabel: taxLabel.trim(),
        taxEnabled,
        taxRatePercent: Number.isFinite(parsedTax) ? parsedTax : 0,
        dashboardReportingBasis,
        dashboardAmountsIncludeGst,
        defaultQuoteValidDays: Number.isFinite(parsedQuoteDays) ? parsedQuoteDays : 14,
        defaultInvoiceDueDays: Number.isFinite(parsedInvoiceDays) ? parsedInvoiceDays : 7,
        defaultTerms,
        paymentDetails,
        defaultIncomeAccountId: defaultIncomeAccountId || null,
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

  const onSaveAll = async () => {
    setUniversalSaving(true)
    setUniversalSuccess(false)
    try {
      await Promise.all([
        // Sales details + tax settings (same API)
        (async () => {
          const parsedTax = Number(taxRatePercent)
          const parsedQuoteDays = Number(defaultQuoteValidDays)
          const parsedInvoiceDays = Number(defaultInvoiceDueDays)
          const parsedFyMonth = Number(fiscalYearStartMonth)
          const fyMonth = Number.isFinite(parsedFyMonth) && parsedFyMonth >= 1 && parsedFyMonth <= 12 ? parsedFyMonth : 7
          await saveSalesSettingsApi({
            businessName, address, abn, phone, email, website,
            businessRegistrationLabel: businessRegistrationLabel.trim() || 'ABN',
            currencyCode: currencyCode.trim() || 'AUD',
            fiscalYearStartMonth: fyMonth,
            quoteLabel: quoteLabel.trim() || 'QUOTE',
            invoiceLabel: invoiceLabel.trim() || 'INVOICE',
            taxLabel: taxLabel.trim(),
            taxEnabled,
            taxRatePercent: Number.isFinite(parsedTax) ? parsedTax : 0,
            dashboardReportingBasis,
            dashboardAmountsIncludeGst,
            defaultQuoteValidDays: Number.isFinite(parsedQuoteDays) ? parsedQuoteDays : 14,
            defaultInvoiceDueDays: Number.isFinite(parsedInvoiceDays) ? parsedInvoiceDays : 7,
            defaultTerms, paymentDetails,
            defaultIncomeAccountId: defaultIncomeAccountId || null,
            updatedAt: new Date().toISOString(),
          })
        })(),
        // Reminders
        (async () => {
          const parsedOverdue = Math.trunc(Number(overdueInvoiceBusinessDaysAfterDue))
          const parsedExpiry = Math.trunc(Number(quoteExpiryBusinessDaysBeforeValidUntil))
          const body = {
            overdueInvoiceRemindersEnabled,
            overdueInvoiceBusinessDaysAfterDue: Number.isFinite(parsedOverdue) ? Math.max(1, parsedOverdue) : 3,
            quoteExpiryRemindersEnabled,
            quoteExpiryBusinessDaysBeforeValidUntil: Number.isFinite(parsedExpiry) ? Math.max(1, parsedExpiry) : 3,
          }
          const res = await apiFetch('/api/admin/sales/reminder-settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          })
          const json = await res.json().catch(() => null)
          if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : 'Failed to save Sales Notifications settings')
          if (json) {
            setOverdueInvoiceRemindersEnabled(Boolean(json.overdueInvoiceRemindersEnabled))
            setOverdueInvoiceBusinessDaysAfterDue(String(typeof json.overdueInvoiceBusinessDaysAfterDue === 'number' ? json.overdueInvoiceBusinessDaysAfterDue : body.overdueInvoiceBusinessDaysAfterDue))
            setQuoteExpiryRemindersEnabled(Boolean(json.quoteExpiryRemindersEnabled))
            setQuoteExpiryBusinessDaysBeforeValidUntil(String(typeof json.quoteExpiryBusinessDaysBeforeValidUntil === 'number' ? json.quoteExpiryBusinessDaysBeforeValidUntil : body.quoteExpiryBusinessDaysBeforeValidUntil))
          }
        })(),
        // Stripe
        (async () => {
          const parsedFee = Number(stripeFeePercent)
          const parsedFixed = Number(stripeFeeFixed)
          const feeFixedCents = Number.isFinite(parsedFixed) ? Math.max(0, Math.round(parsedFixed * 100)) : 0
          const res = await apiFetch('/api/admin/sales/stripe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enabled: stripeEnabled, label: stripeLabel,
              feePercent: Number.isFinite(parsedFee) ? parsedFee : 0,
              feeFixedCents,
              publishableKey: stripePublishableKey || null,
              secretKey: stripeSecretKey || null,
              dashboardPaymentDescription: stripeDashboardPaymentDescription,
              currencies: stripeCurrencies,
            }),
          })
          const json = await res.json().catch(() => null)
          if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : 'Unable to save Stripe settings')
          if (json) {
            setStripeEnabled(Boolean(json.enabled))
            setStripeLabel(typeof json.label === 'string' ? json.label : stripeLabel)
            setStripeFeePercent(String(typeof json.feePercent === 'number' ? json.feePercent : parsedFee))
            setStripeFeeFixed(String(typeof json.feeFixedCents === 'number' ? (Math.max(0, Math.trunc(json.feeFixedCents)) / 100).toFixed(2) : (feeFixedCents / 100).toFixed(2)))
            setStripePublishableKey(typeof json.publishableKey === 'string' ? json.publishableKey : stripePublishableKey)
            setStripeDashboardPaymentDescription(typeof json.dashboardPaymentDescription === 'string' ? json.dashboardPaymentDescription : stripeDashboardPaymentDescription)
            setStripeCurrencies(typeof json.currencies === 'string' ? json.currencies : stripeCurrencies)
            setStripeHasSecretKey(Boolean(json.hasSecretKey))
            const src = typeof json.secretKeySource === 'string' ? json.secretKeySource : stripeSecretKeySource
            setStripeSecretKeySource(src === 'env' || src === 'db' || src === 'none' ? src : stripeSecretKeySource)
            setStripeSecretKey('')
          }
        })(),
        // QuickBooks settings
        (async () => {
          const parsedLookback = Number(qbLookbackDays)
          const body = {
            dailyPullEnabled: qbDailyPullEnabled,
            dailyPullTime: qbDailyPullTime,
            pullLookbackDays: Number.isFinite(parsedLookback) ? parsedLookback : 7,
          }
          const res = await apiFetch('/api/sales/quickbooks/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          })
          const json = await res.json().catch(() => null)
          if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : 'Failed to save QuickBooks settings')
          if (json) {
            setQbDailyPullEnabled(Boolean(json.dailyPullEnabled))
            setQbDailyPullTime(typeof json.dailyPullTime === 'string' ? json.dailyPullTime : qbDailyPullTime)
            setQbLookbackDays(String(typeof json.pullLookbackDays === 'number' ? json.pullLookbackDays : Number(qbLookbackDays)))
            setQbLastAttempt({
              attemptedAt: typeof json.lastDailyPullAttemptAt === 'string' ? json.lastDailyPullAttemptAt : null,
              succeeded: typeof json.lastDailyPullSucceeded === 'boolean' ? json.lastDailyPullSucceeded : null,
              message: typeof json.lastDailyPullMessage === 'string' ? json.lastDailyPullMessage : null,
            })
          }
        })(),
      ])
      setUniversalSuccess(true)
      setSavedSnapshot('')
      setTimeout(() => setUniversalSuccess(false), 2500)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      setUniversalSaving(false)
    }
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">Loading settings…</div>
    )
  }

  return (
    <div>
      <div className="mb-4 sm:mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Sales settings</h2>
            <p className="text-sm text-muted-foreground">Defaults used when creating quotes and invoices.</p>
          </div>
          <Button onClick={onSaveAll} disabled={universalSaving} size="lg" className="w-full sm:w-auto">
            <Save className="w-4 h-4 mr-2" />
            {universalSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>

      {universalSuccess && (
        <div className="mb-4 sm:mb-6 p-3 sm:p-4 bg-success-visible border-2 border-success-visible rounded-lg">
          <p className="text-xs sm:text-sm text-success font-medium">Changes saved successfully!</p>
        </div>
      )}

      <div className="lg:flex gap-6">
        <div className="hidden lg:block w-52 xl:w-60 flex-shrink-0">
          <nav className="space-y-0.5 sticky top-6">
            {SALES_SECTIONS.map((section) => {
              const SectionIcon = section.icon
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-md text-sm flex items-center gap-2.5 transition-colors',
                    activeSection === section.id
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  )}
                >
                  <SectionIcon className="w-4 h-4 flex-shrink-0" />
                  {section.label}
                </button>
              )
            })}
          </nav>
        </div>

        <div className="flex-1 min-w-0 space-y-4 sm:space-y-6">
          <div className={cn(activeSection !== 'sales-details' && 'lg:hidden')}>
      <Card>
        <CardContent className="space-y-4 pt-6">
          {/* Row 1: Business name / Email / Address  |  Row 2: Phone / Website / Address continues */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr] md:grid-rows-[auto_auto] gap-4">
            <div className="space-y-2">
              <Label>Business name</Label>
              <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className="h-9" />
            </div>

            <div className="space-y-2">
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" placeholder="accounts@" />
            </div>

            <div className="space-y-2 md:row-span-2">
              <Label>Address</Label>
              <Textarea value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street\nSuburb State Postcode" className="h-[calc(100%-1.75rem)]" />
            </div>

            <div className="space-y-2">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9" />
            </div>

            <div className="space-y-2">
              <Label>Website</Label>
              <Input value={website} onChange={(e) => setWebsite(e.target.value)} className="h-9" placeholder="https://" />
            </div>
          </div>

          {/* Row 3: Business registration label / ABN / Currency code / FY Start Month */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Business registration label</Label>
              <Input value={businessRegistrationLabel} onChange={(e) => setBusinessRegistrationLabel(e.target.value)} className="h-9" placeholder="ABN, GST No, VAT No, EIN, etc" />
              <p className="text-xs text-muted-foreground">e.g. ABN, GST No, VAT No, EIN.</p>
            </div>

            <div className="space-y-2">
              <Label>{businessRegistrationLabel || 'Business registration number'}</Label>
              <Input value={abn} onChange={(e) => setAbn(e.target.value)} className="h-9" />
              <p className="text-xs text-muted-foreground">Update Business registration label to change this label.</p>
            </div>

            <div className="space-y-2">
              <Label>Currency code</Label>
              <Input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="h-9" placeholder="AUD" />
              <p className="text-xs text-muted-foreground">e.g. AUD, USD, EUR, GBP. Symbol: {getCurrencySymbol(currencyCode)}</p>
            </div>

            <div className="space-y-2">
              <Label>FY Start Month</Label>
              <Input value={fiscalYearStartMonth} onChange={(e) => setFiscalYearStartMonth(e.target.value)} className="h-9" inputMode="numeric" placeholder="7" />
              <p className="text-xs text-muted-foreground">1-12 (1=Jan, 7=Jul). Used for sales dashboard.</p>
            </div>
          </div>

          {/* Row 4: Quote label / Default quote validity / Invoice label / Default invoice due */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Quote label</Label>
              <Input value={quoteLabel} onChange={(e) => setQuoteLabel(e.target.value)} className="h-9" placeholder="QUOTE" />
              <p className="text-xs text-muted-foreground">e.g. QUOTE, ESTIMATE, PROPOSAL.</p>
            </div>

            <div className="space-y-2">
              <Label>Default quote validity (days)</Label>
              <Input
                value={defaultQuoteValidDays}
                onChange={(e) => setDefaultQuoteValidDays(e.target.value)}
                className="h-9"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">Used to prefill &ldquo;Valid until&rdquo;.</p>
            </div>

            <div className="space-y-2">
              <Label>Invoice label</Label>
              <Input value={invoiceLabel} onChange={(e) => setInvoiceLabel(e.target.value)} className="h-9" placeholder="INVOICE" />
              <p className="text-xs text-muted-foreground">e.g. INVOICE, TAX INVOICE, BILL.</p>
            </div>

            <div className="space-y-2">
              <Label>Default invoice due (days)</Label>
              <Input
                value={defaultInvoiceDueDays}
                onChange={(e) => setDefaultInvoiceDueDays(e.target.value)}
                className="h-9"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">Used to prefill &ldquo;Due date&rdquo;.</p>
            </div>
          </div>

          {/* Row 5: Payment details / Default T&Cs */}
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

        </CardContent>
      </Card>
          </div>

          <div className={cn(activeSection !== 'dashboard' && 'lg:hidden')}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sales Dashboard</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Reporting basis</Label>
              <Select value={dashboardReportingBasis} onValueChange={(value) => setDashboardReportingBasis(value as 'CASH' | 'ACCRUAL')}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACCRUAL">Accrual (invoice issue date)</SelectItem>
                  <SelectItem value="CASH">Cash (payment date)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Applies to the FY sales KPI and Sales Overview chart.</p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
                <div>
                  <Label>Include GST in dashboard totals</Label>
                  <p className="text-xs text-muted-foreground mt-1">Turn this off to show ex-GST amounts across dashboard sales totals.</p>
                </div>
                <Switch checked={dashboardAmountsIncludeGst} onCheckedChange={setDashboardAmountsIncludeGst} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
          </div>

          <div className={cn(activeSection !== 'tax' && 'lg:hidden')}>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-base">Tax</CardTitle>
          <Switch checked={taxEnabled} onCheckedChange={(v) => { setTaxEnabled(v); setSaved(false) }} disabled={!taxRatesLoaded} />
        </CardHeader>
        {taxEnabled && (
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Tax label</Label>
                <Input value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} className="h-9" placeholder="GST, VAT, etc" />
                <p className="text-xs text-muted-foreground">Shown next to &ldquo;Tax&rdquo; on quotes/invoices, e.g. Tax (GST).</p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <h3 className="text-sm font-medium">Tax Rates</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingRate({ name: '', rate: '' })
                  setTaxRateModalOpen(true)
                }}
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" /> New Tax
              </Button>
            </div>

            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium">Tax Name</th>
                    <th className="px-3 py-2 text-left text-xs font-medium w-24">Rate (%)</th>
                    <th className="px-3 py-2 text-right text-xs font-medium w-28">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {taxRates.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2">
                        <span className="text-sm">{r.name}</span>
                        {r.isDefault && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">Primary</span>}
                      </td>
                      <td className="px-3 py-2 text-sm">{r.rate}%</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditingRate({ id: r.id, name: r.name, rate: String(r.rate) })
                              setTaxRateModalOpen(true)
                            }}
                            title="Edit"
                            aria-label="Edit"
                            className="h-9 w-9 p-0"
                            disabled={taxRatesBusy}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              if (r.isDefault) return
                              setTaxRatesBusy(true)
                              try {
                                const updated = taxRates.map((x) => ({
                                  ...x,
                                  isDefault: x.id === r.id,
                                }))
                                const savedRates = await saveTaxRatesBulk(updated)
                                setTaxRates(savedRates)
                                const def = savedRates.find((x) => x.isDefault)
                                if (def) setTaxRatePercent(String(def.rate))
                              } catch (e) {
                                alert(e instanceof Error ? e.message : 'Failed to update primary rate')
                              } finally {
                                setTaxRatesBusy(false)
                              }
                            }}
                            title={r.isDefault ? 'Primary rate' : 'Set as primary'}
                            aria-label={r.isDefault ? 'Primary rate' : 'Set as primary'}
                            className="h-9 w-9 p-0"
                            disabled={taxRatesBusy || r.isDefault}
                          >
                            <Star className={r.isDefault ? 'w-4 h-4 text-primary' : 'w-4 h-4'} />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              if (taxRates.length <= 1) return
                              if (!confirm(`Remove "${r.name}"?`)) return
                              setTaxRatesBusy(true)
                              try {
                                const res = await apiFetch(`/api/admin/sales/tax-rates?id=${encodeURIComponent(r.id)}`, { method: 'DELETE' })
                                if (!res.ok) {
                                  const json = await res.json().catch(() => null)
                                  alert(typeof json?.error === 'string' ? json.error : 'Failed to remove tax rate')
                                  return
                                }
                                const rates = await fetchTaxRates()
                                setTaxRates(rates)
                                const def = rates.find((x) => x.isDefault)
                                if (def) setTaxRatePercent(String(def.rate))
                              } catch (e) {
                                alert(e instanceof Error ? e.message : 'Failed to remove tax rate')
                              } finally {
                                setTaxRatesBusy(false)
                              }
                            }}
                            title="Remove"
                            aria-label="Remove"
                            className="h-9 w-9 p-0"
                            disabled={taxRatesBusy || taxRates.length <= 1}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {taxRates.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-4 text-center text-sm text-muted-foreground">
                        No tax rates configured. Click &ldquo;+ New Tax&rdquo; to add one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          </CardContent>
        )}
      </Card>
          </div>

          <div className={cn(activeSection !== 'labels' && 'lg:hidden')}>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Labels</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Labels can be applied to line items on quotes and invoices to categorise them. Optionally link each label to an income account for reporting.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditingLabel(null)
              setLabelFormName('')
              setLabelFormColor('#6366F1')
              setLabelFormAccountId('')
              setLabelFormError(null)
              setLabelModalOpen(true)
            }}
          >
            <Plus className="w-4 h-4 mr-1" />
            New Label
          </Button>
        </CardHeader>
        <CardContent>
          <div className="mb-6 pb-6 border-b border-border space-y-2">
            <Label className="text-sm font-medium">Default Sales Income Account</Label>
            <p className="text-xs text-muted-foreground">Line items with no label, or labels without a linked account, will be reported under this account. If left blank they appear as &ldquo;Sales Revenue&rdquo;.</p>
            <Select
              value={defaultIncomeAccountId}
              onValueChange={(value) => setDefaultIncomeAccountId(value === DEFAULT_INCOME_ACCOUNT_VALUE ? '' : value)}
            >
              <SelectTrigger className="h-9 max-w-sm">
                <SelectValue placeholder="— Sales Revenue (default) —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_INCOME_ACCOUNT_VALUE}>— Sales Revenue (default) —</SelectItem>
                {incomeAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.code} – {a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Saved with the main &ldquo;Save changes&rdquo; button above.</p>
          </div>
          {!labelsLoaded ? (
            <div className="text-sm text-muted-foreground">Loading labels…</div>
          ) : labels.length === 0 ? (
            <p className="text-sm text-muted-foreground">No labels yet. Click &ldquo;New Label&rdquo; to add one.</p>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-8"></th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Account</th>
                    <th className="px-3 py-2 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {labels.map((lbl) => (
                    <tr key={lbl.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <span
                          className="inline-block w-4 h-4 rounded-sm flex-shrink-0"
                          style={{ backgroundColor: lbl.color ?? '#6366F1' }}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">{lbl.name}</td>
                      <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">
                        {lbl.accountCode ? `${lbl.accountCode} – ${lbl.accountName}` : <span className="italic">No account</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 justify-end">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => {
                              setEditingLabel(lbl)
                              setLabelFormName(lbl.name)
                              setLabelFormColor(lbl.color ?? '#6366F1')
                              setLabelFormAccountId(lbl.accountId ?? '')
                              setLabelFormError(null)
                              setLabelModalOpen(true)
                            }}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={async () => {
                              if (!confirm(`Delete label "${lbl.name}"? It will be removed from any library items that use it. Labels already captured on quotes/invoices will retain their name snapshot.`)) return
                              try {
                                await deleteSalesLabel(lbl.id)
                                setLabels((prev) => prev.filter((x) => x.id !== lbl.id))
                              } catch (e) {
                                alert(e instanceof Error ? e.message : 'Failed to delete label')
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
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

      {/* Label add/edit modal */}
      <Dialog open={labelModalOpen} onOpenChange={(open) => { if (!labelModalSaving) setLabelModalOpen(open) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingLabel ? 'Edit Label' : 'New Label'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={labelFormName}
                onChange={(e) => { setLabelFormName(e.target.value); setLabelFormError(null) }}
                placeholder="e.g. Consultation, Licensing, Travel"
                className="h-9"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveLabel() }}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Color</Label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={labelFormColor}
                  onChange={(e) => setLabelFormColor(e.target.value)}
                  className="h-9 w-14 rounded-md border border-border cursor-pointer p-0.5"
                  title="Pick a color"
                />
                <span className="text-sm text-muted-foreground font-mono">{labelFormColor.toUpperCase()}</span>
                <div className="flex gap-1.5 flex-wrap">
                  {['#6366F1','#10B981','#F59E0B','#EF4444','#3B82F6','#8B5CF6','#EC4899','#14B8A6'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${labelFormColor.toUpperCase() === c.toUpperCase() ? 'border-foreground scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setLabelFormColor(c)}
                      title={c}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Income Account <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select
                value={labelFormAccountId}
                onValueChange={(value) => setLabelFormAccountId(value === NO_LABEL_ACCOUNT_VALUE ? '' : value)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="— No account linked —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LABEL_ACCOUNT_VALUE}>— No account linked —</SelectItem>
                  {incomeAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} – {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Links this label to a Chart of Accounts income account for reporting.</p>
            </div>

            {labelFormError && <p className="text-sm text-destructive">{labelFormError}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setLabelModalOpen(false)} disabled={labelModalSaving}>Cancel</Button>
              <Button onClick={() => void handleSaveLabel()} disabled={labelModalSaving || !labelFormName.trim()}>
                {labelModalSaving ? 'Saving…' : editingLabel ? 'Save changes' : 'Create label'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
          </div>

          <div className={cn(activeSection !== 'sales-notifications' && 'lg:hidden')}>
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

            </>
          )}
        </CardContent>
      </Card>
          </div>

          <div className={cn(activeSection !== 'stripe-checkout' && 'lg:hidden')}>
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
                    <Label>Fixed fee ({getCurrencySymbol(currencyCode)})</Label>
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

            </>
          )}
        </CardContent>
      </Card>
          </div>

          <div className={cn(activeSection !== 'quickbooks' && 'lg:hidden')}>
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Daily pull task</Label>
                <Input
                  type="time"
                  value={qbDailyPullTime}
                  onChange={(e) => setQbDailyPullTime(e.target.value)}
                  className="h-9"
                  disabled={!qbDailyPullEnabled || qbBusy || universalSaving}
                />
              </div>

              <div className="space-y-2">
                <Label>Lookback (days)</Label>
                <Input
                  value={qbLookbackDays}
                  onChange={(e) => setQbLookbackDays(e.target.value)}
                  className="h-9"
                  inputMode="numeric"
                  disabled={qbBusy || universalSaving}
                />
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

        </div>
      </div>

      {universalSuccess && (
        <div className="mt-4 sm:mt-6 p-3 sm:p-4 bg-success-visible border-2 border-success-visible rounded-lg">
          <p className="text-xs sm:text-sm text-success font-medium">Changes saved successfully!</p>
        </div>
      )}

      <div className="mt-6 sm:mt-8 pb-20 lg:pb-24 flex justify-end">
        <Button onClick={onSaveAll} disabled={universalSaving} size="lg" className="w-full sm:w-auto">
          <Save className="w-4 h-4 mr-2" />
          {universalSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>

      {/* Tax Rate Add/Edit Modal */}
      <Dialog open={taxRateModalOpen} onOpenChange={setTaxRateModalOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingRate?.id ? 'Edit tax rate' : 'New tax rate'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Tax name</Label>
              <Input
                value={editingRate?.name ?? ''}
                onChange={(e) => setEditingRate((prev) => prev ? { ...prev, name: e.target.value } : prev)}
                className="h-9"
                placeholder="e.g. GST, VAT"
              />
            </div>
            <div className="space-y-2">
              <Label>Rate (%)</Label>
              <Input
                value={editingRate?.rate ?? ''}
                onChange={(e) => setEditingRate((prev) => prev ? { ...prev, rate: e.target.value } : prev)}
                className="h-9"
                inputMode="decimal"
                placeholder="10"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setTaxRateModalOpen(false)}>Cancel</Button>
              <Button
                disabled={taxRateModalSaving || !editingRate?.name?.trim()}
                onClick={async () => {
                  if (!editingRate?.name?.trim()) return
                  setTaxRateModalSaving(true)
                  try {
                    const parsedRate = Number(editingRate.rate)
                    const rate = Number.isFinite(parsedRate) && parsedRate >= 0 ? parsedRate : 0

                    if (editingRate.id) {
                      // Edit existing rate via bulk save
                      const updated = taxRates.map((x) => x.id === editingRate.id ? { ...x, name: editingRate.name.trim(), rate } : x)
                      const savedRates = await saveTaxRatesBulk(updated)
                      setTaxRates(savedRates)
                    } else {
                      // Add new rate via bulk save
                      const maxOrder = taxRates.reduce((m, r) => Math.max(m, r.sortOrder), 0)
                      const isFirst = taxRates.length === 0
                      const newRate = {
                        id: `new-${Date.now()}`,
                        name: editingRate.name.trim(),
                        rate,
                        isDefault: isFirst,
                        sortOrder: maxOrder + 1,
                      }
                      const all = [...taxRates, newRate]
                      // Ensure at least one default
                      if (!all.some((r) => r.isDefault) && all.length > 0) all[0] = { ...all[0], isDefault: true }
                      const cleaned = all.map((r, i) => ({
                        id: r.id.startsWith('new-') ? undefined : r.id,
                        name: r.name,
                        rate: r.rate,
                        isDefault: r.isDefault,
                        sortOrder: i,
                      }))
                      const savedRates = await saveTaxRatesBulk(cleaned as SalesTaxRate[])
                      setTaxRates(savedRates)
                      const def = savedRates.find((r) => r.isDefault)
                      if (def) setTaxRatePercent(String(def.rate))
                    }

                    setTaxRateModalOpen(false)
                  } catch (e) {
                    alert(e instanceof Error ? e.message : 'Failed to save tax rate')
                  } finally {
                    setTaxRateModalSaving(false)
                  }
                }}
              >
                {taxRateModalSaving ? 'Saving\u2026' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
