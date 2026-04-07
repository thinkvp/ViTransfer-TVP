'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertTriangle, BarChart3, Building2, CreditCard, DollarSign, FileText, Receipt } from 'lucide-react'
import {
  fetchSalesRollup,
  fetchSalesSettings,
} from '@/lib/sales/admin-api'
import { apiFetch } from '@/lib/api-client'
import type { SalesRollupResponse } from '@/lib/sales/admin-api'
import type { InvoiceStatus, QuoteStatus, SalesSettings } from '@/lib/sales/types'
import { invoiceStatusBadgeClass, invoiceStatusLabel, quoteStatusBadgeClass, quoteStatusLabel } from '@/lib/sales/badge'
import { fetchClientOptions } from '@/lib/sales/lookups'
import { centsToDollars, formatMoney, sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { parseDateOnlyLocal, quoteEffectiveStatus } from '@/lib/sales/status'
import { formatDate } from '@/lib/utils'
import { getCurrencySymbol } from '@/lib/sales/currency'
import { SalesDashboardCharts } from '@/components/sales/SalesDashboardCharts'
import { getInvoiceDashboardAmountCents, getPaymentDashboardAmountCents, getSalesDashboardReportingBasis, salesDashboardIncludesGst } from '@/lib/sales/dashboard-reporting'

export default function SalesDashboardPage() {
  const [tick, setTick] = useState(0)
  const [nowIso, setNowIso] = useState<string | null>(null)
  const [clientNameById, setClientNameById] = useState<Record<string, string>>({})

  const [loading, setLoading] = useState(true)

  const [qbActionsEnabled, setQbActionsEnabled] = useState<boolean | null>(null)
  const [qbBusy, setQbBusy] = useState(false)
  const [qbActionMessage, setQbActionMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [settings, setSettings] = useState<SalesSettings>({
    businessName: '',
    address: '',
    abn: '',
    phone: '',
    email: '',
    website: '',
    businessRegistrationLabel: 'ABN',
    currencyCode: 'AUD',
    fiscalYearStartMonth: 7,
    quoteLabel: 'QUOTE',
    invoiceLabel: 'INVOICE',
    taxLabel: '',
    taxEnabled: true,
    taxRatePercent: 10,
    defaultQuoteValidDays: 14,
    defaultInvoiceDueDays: 7,
    defaultTerms: '',
    paymentDetails: '',
    updatedAt: new Date(0).toISOString(),
  })
  const [rollup, setRollup] = useState<SalesRollupResponse | null>(null)

  useEffect(() => {
    // Local-storage pages: re-render when returning to this tab.
    const onFocus = () => {
      setNowIso(new Date().toISOString())
      setTick((v) => v + 1)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    ;(async () => {
      try {
        const [s, r, qbEnabled] = await Promise.all([
          fetchSalesSettings(),
          fetchSalesRollup({
            invoicesLimit: 2000,
            quotesLimit: 2000,
            paymentsLimit: 5000,
            stripePaymentsLimit: 5000,
          }),
          apiFetch('/api/sales/quickbooks/settings', { method: 'GET' })
            .then(async (res) => {
              const json = await res.json().catch(() => null)
              return json?.dailyPullEnabled === true
            })
            .catch(() => false),
        ])
        if (cancelled) return
        setSettings(s)
        setRollup(r)
        setQbActionsEnabled(qbEnabled)
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    setNowIso(new Date().toISOString())
  }, [])

  useEffect(() => {
    const run = async () => {
      const clients = await fetchClientOptions().catch(() => [])
      setClientNameById(Object.fromEntries(clients.map((c) => [c.id, c.name])))
    }
    void run()
  }, [])

  const runQbPull = async (
    url: string,
    singular: string,
    plural: string,
    extractCount: (json: any) => number,
  ) => {
    setQbBusy(true)
    setQbActionMessage(null)
    try {
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 7 }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        const count = extractCount(json)
        const text =
          count === 0
            ? `No ${plural} to pull`
            : count === 1
            ? `Successfully pulled 1 ${singular}`
            : `Successfully pulled ${count} ${plural}`
        setQbActionMessage({ text, isError: false })
        setTick((v) => v + 1)
      } else {
        const errText = typeof (json as any)?.error === 'string' ? (json as any).error : `Pull failed (${res.status}).`
        setQbActionMessage({ text: errText, isError: true })
      }
    } catch (e) {
      setQbActionMessage({ text: `Pull failed: ${e instanceof Error ? e.message : String(e)}`, isError: true })
    } finally {
      setQbBusy(false)
      setTimeout(() => setQbActionMessage(null), 3000)
    }
  }

  const stats = useMemo(() => {
    return rollup?.stats ?? {
      openQuotes: 0,
      openQuoteDrafts: 0,
      openInvoices: 0,
      overdueInvoices: 0,
      openBalanceCents: 0,
    }
  }, [rollup?.stats])

  const salesOverview = useMemo(() => {
    const now = nowIso ? new Date(nowIso) : new Date()
    const dashboardBasis = getSalesDashboardReportingBasis(settings)
    const includeGst = salesDashboardIncludesGst(settings)
    
    // Get fiscal year start month from settings (1-12), default to 7 (July)
    const fyStartMonth = settings.fiscalYearStartMonth ?? 7
    const fyStartMonthZeroIndexed = Math.max(1, Math.min(12, fyStartMonth)) - 1 // Convert to 0-11
    
    // Calculate which FY year we're in
    const fyStartYear = now.getMonth() >= fyStartMonthZeroIndexed ? now.getFullYear() : now.getFullYear() - 1
    
    // FY runs from fyStartMonth of fyStartYear to (fyStartMonth-1) of fyStartYear+1
    const fyStart = new Date(fyStartYear, fyStartMonthZeroIndexed, 1)
    
    // Calculate last day of month before fyStartMonth in following year
    const fyEndMonth = fyStartMonthZeroIndexed === 0 ? 11 : fyStartMonthZeroIndexed - 1
    const fyEndYear = fyStartMonthZeroIndexed === 0 ? fyStartYear : fyStartYear + 1
    const fyEnd = new Date(fyEndYear, fyEndMonth + 1, 0, 23, 59, 59, 999) // Last day of fyEndMonth
    
    const financialYearLabel = `${String(fyStartYear).slice(-2)}-${String(fyStartYear + 1).slice(-2)}`

    const invoices = rollup?.invoices ?? []
    const invoiceRollupById = rollup?.invoiceRollupById ?? {}
    const payments = rollup?.payments ?? []
    const invoiceById = Object.fromEntries(invoices.map((invoice) => [invoice.id, invoice]))
    const dashboardModeLabel = `${dashboardBasis === 'CASH' ? 'Cash' : 'Accrual'} ${includeGst ? 'inc GST' : 'ex GST'}`

    const overdueBalanceCents = invoices.reduce((acc, inv) => {
      const r = invoiceRollupById[inv.id]
      const effectiveStatus = (r?.effectiveStatus as InvoiceStatus) ?? inv.status
      if (effectiveStatus !== 'OVERDUE') return acc
      const balance = Number.isFinite(Number(r?.balanceCents)) ? Number(r!.balanceCents) : 0
      return acc + Math.max(0, Math.trunc(balance))
    }, 0)

    const recentPaymentsThresholdMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).getTime()
    const recentPaymentsTotalCents = payments.reduce((acc, p) => {
      // Skip reconciliation/mirror entries (e.g. QBO mirroring a Stripe payment)
      if (p.excludeFromInvoiceBalance) return acc
      const d = parseDateOnlyLocal(p.paymentDate)
      if (!d || (d as Date).getTime() < recentPaymentsThresholdMs) return acc
      return acc + getPaymentDashboardAmountCents(p, p.invoiceId ? invoiceById[p.invoiceId] : null, settings.taxRatePercent, includeGst)
    }, 0)

    const totalSalesCents = dashboardBasis === 'CASH'
      ? payments.reduce((acc, payment) => {
          if (payment.excludeFromInvoiceBalance) return acc
          const paymentDate = parseDateOnlyLocal(payment.paymentDate)
          if (!paymentDate) return acc
          const paidAt = (paymentDate as Date).getTime()
          if (paidAt < fyStart.getTime() || paidAt > fyEnd.getTime()) return acc
          return acc + getPaymentDashboardAmountCents(payment, payment.invoiceId ? invoiceById[payment.invoiceId] : null, settings.taxRatePercent, includeGst)
        }, 0)
      : invoices.reduce((acc, inv) => {
          const issueDate = parseDateOnlyLocal(inv.issueDate)
          if (!issueDate) return acc
          const issuedAt = (issueDate as Date).getTime()
          if (issuedAt < fyStart.getTime() || issuedAt > fyEnd.getTime()) return acc
          return acc + getInvoiceDashboardAmountCents(inv, settings.taxRatePercent, includeGst, invoiceRollupById[inv.id])
        }, 0)

    return {
      overdueBalanceCents,
      recentPaymentsTotalCents,
      totalSalesCents,
      financialYearLabel,
      dashboardModeLabel,
    }
  }, [nowIso, rollup, settings])

  const dashboardData = useMemo(() => {
    const nowMs = nowIso ? new Date(nowIso).getTime() : 0

    const invoices = rollup?.invoices ?? []
    const quotes = rollup?.quotes ?? []
    const payments = rollup?.payments ?? []
    const invoiceRollupById = rollup?.invoiceRollupById ?? {}

    const quoteRows = quotes
      .map((q) => {
        const effectiveStatus = quoteEffectiveStatus(q, nowMs)

        const subtotal = sumLineItemsSubtotal(q.items)
        const tax = sumLineItemsTax(q.items, settings.taxRatePercent)
        const total = subtotal + tax

        return { quote: q, effectiveStatus, totalCents: total }
      })
      .filter((r) => r.effectiveStatus === 'OPEN' || r.effectiveStatus === 'SENT' || r.effectiveStatus === 'OPENED')
      .sort((a, b) => b.quote.issueDate.localeCompare(a.quote.issueDate))
      .slice(0, 10)

    const invoiceRows = invoices
      .map((inv) => {
        const r = invoiceRollupById[inv.id]
        const effectiveStatus = (r?.effectiveStatus as InvoiceStatus) ?? inv.status
        const balance = Number.isFinite(Number(r?.balanceCents)) ? Number(r!.balanceCents) : 0

        return { invoice: inv, effectiveStatus, balanceCents: Math.max(0, Math.trunc(balance)) }
      })
      .filter((r) => r.effectiveStatus !== 'PAID')
      .sort((a, b) => {
        const ad = a.invoice.dueDate ?? '9999-12-31'
        const bd = b.invoice.dueDate ?? '9999-12-31'
        return ad.localeCompare(bd)
      })
      .slice(0, 10)

    const thresholdMs = nowMs
      ? new Date(new Date(nowMs).setDate(new Date(nowMs).getDate() - 30)).getTime()
      : 0
    const recentPayments = payments
      .filter((p) => {
        if (p.excludeFromInvoiceBalance) return false
        const d = parseDateOnlyLocal(p.paymentDate)
        return Boolean(d) && (d as Date).getTime() >= thresholdMs
      })
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))
      .slice(0, 10)

    const invoiceNumberById = Object.fromEntries(invoices.map((i) => [i.id, i.invoiceNumber]))

    return { quoteRows, invoiceRows, recentPayments, invoiceNumberById }
  }, [nowIso, rollup, settings.taxRatePercent])

  return (
    <div className="space-y-4 sm:space-y-6">
      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            <div className="flex items-center gap-2">
              <div className="rounded-lg p-2.5 flex-shrink-0 bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/20">
                <FileText className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Open quotes</p>
                <p className="text-base font-semibold tabular-nums truncate">{stats.openQuotes}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-lg p-2.5 flex-shrink-0 bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/20">
                <Receipt className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Open invoices</p>
                <p className="text-base font-semibold tabular-nums truncate">{stats.openInvoices}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-lg p-2.5 flex-shrink-0 bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/20">
                <DollarSign className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Awaiting payment</p>
                <p className="text-base font-semibold tabular-nums truncate">{formatMoney(stats.openBalanceCents, getCurrencySymbol(settings.currencyCode))}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-lg p-2.5 flex-shrink-0 bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/20">
                <AlertTriangle className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Overdue</p>
                <p className="text-base font-semibold tabular-nums truncate">{formatMoney(salesOverview.overdueBalanceCents, getCurrencySymbol(settings.currencyCode))}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-lg p-2.5 flex-shrink-0 bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/20">
                <CreditCard className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Paid &lt;30 days</p>
                <p className="text-[10px] text-muted-foreground">{salesOverview.dashboardModeLabel}</p>
                <p className="text-base font-semibold tabular-nums truncate">{formatMoney(salesOverview.recentPaymentsTotalCents, getCurrencySymbol(settings.currencyCode))}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-lg p-2.5 flex-shrink-0 bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/20">
                <BarChart3 className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Sales FY{salesOverview.financialYearLabel}</p>
                <p className="text-[10px] text-muted-foreground">{salesOverview.dashboardModeLabel}</p>
                <p className="text-base font-semibold tabular-nums truncate">{formatMoney(salesOverview.totalSalesCents, getCurrencySymbol(settings.currencyCode))}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <SalesDashboardCharts rollup={rollup} settings={settings} nowIso={nowIso} />

      {qbActionsEnabled && (
        <Card>
          <CardContent className="p-4 sm:p-5">
            <div className="flex flex-col items-center sm:flex-row sm:justify-center gap-3">
              <p className="text-base font-semibold">QuickBooks Actions</p>
              <div className="grid grid-cols-2 sm:flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={qbBusy}
                  onClick={() => void runQbPull('/api/sales/quickbooks/pull/customers', 'client', 'clients', (j) => (j?.created ?? 0))}
                >
                  <Building2 className="w-3.5 h-3.5" />
                  {qbBusy ? 'Working…' : 'Pull Clients'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={qbBusy}
                  onClick={() => void runQbPull('/api/sales/quickbooks/pull/quotes', 'quote', 'quotes', (j) => (j?.stored?.created ?? 0))}
                >
                  <FileText className="w-3.5 h-3.5" />
                  {qbBusy ? 'Working…' : 'Pull Quotes'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={qbBusy}
                  onClick={() => void runQbPull('/api/sales/quickbooks/pull/invoices', 'invoice', 'invoices', (j) => (j?.stored?.created ?? 0))}
                >
                  <Receipt className="w-3.5 h-3.5" />
                  {qbBusy ? 'Working…' : 'Pull Invoices'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={qbBusy}
                  onClick={() => void runQbPull('/api/sales/quickbooks/pull/payments', 'payment', 'payments', (j) => (j?.stored?.created ?? 0))}
                >
                  <DollarSign className="w-3.5 h-3.5" />
                  {qbBusy ? 'Working…' : 'Pull Payments'}
                </Button>
              </div>
            </div>
            {qbActionMessage && (
              <div className={`mt-3 p-3 sm:p-4 rounded-lg border-2 ${
                qbActionMessage.isError
                  ? 'bg-destructive-visible border-destructive-visible'
                  : 'bg-success-visible border-success-visible'
              }`}>
                <p className={`text-xs sm:text-sm font-medium ${
                  qbActionMessage.isError ? 'text-destructive' : 'text-success'
                }`}>{qbActionMessage.text}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Open quotes</CardTitle>
            <Link href="/admin/sales/quotes/new"><Button size="sm">Create quote</Button></Link>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
            ) : dashboardData.quoteRows.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">No open quotes.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-border">
                      <th className="py-2 pr-3 whitespace-nowrap">Quote</th>
                      <th className="py-2 pr-3 min-w-[120px]">Client</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Issue date</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Status</th>
                      <th className="py-2 pr-3 text-right whitespace-nowrap">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardData.quoteRows.map((r) => (
                      <tr key={r.quote.id} className="border-b border-border/60 last:border-b-0">
                        <td className="py-2 pr-3 font-medium whitespace-nowrap">
                          <Link href={`/admin/sales/quotes/${encodeURIComponent(r.quote.id)}`} className="hover:underline">
                            {r.quote.quoteNumber}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground min-w-[120px]">
                          {r.quote.clientId ? (
                            <Link href={`/admin/clients/${encodeURIComponent(r.quote.clientId)}`} className="hover:underline">
                              {clientNameById[r.quote.clientId] ?? r.quote.clientId}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{formatDate(r.quote.issueDate)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs ${quoteStatusBadgeClass(r.effectiveStatus)}`}>
                            {quoteStatusLabel(r.effectiveStatus)}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-medium whitespace-nowrap">{formatMoney(r.totalCents, getCurrencySymbol(settings.currencyCode))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 flex justify-end">
              <Link href="/admin/sales/quotes"><Button variant="outline" size="sm">View all quotes</Button></Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Open invoices</CardTitle>
            <Link href="/admin/sales/invoices/new"><Button size="sm">Create invoice</Button></Link>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
            ) : dashboardData.invoiceRows.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">No open invoices.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-border">
                      <th className="py-2 pr-3 whitespace-nowrap">Invoice</th>
                      <th className="py-2 pr-3 min-w-[120px]">Client</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Due date</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Status</th>
                      <th className="py-2 pr-3 text-right whitespace-nowrap">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardData.invoiceRows.map((r) => (
                      <tr key={r.invoice.id} className="border-b border-border/60 last:border-b-0">
                        <td className="py-2 pr-3 font-medium whitespace-nowrap">
                          <Link href={`/admin/sales/invoices/${encodeURIComponent(r.invoice.id)}`} className="hover:underline">
                            {r.invoice.invoiceNumber}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground min-w-[120px]">
                          {r.invoice.clientId ? (
                            <Link href={`/admin/clients/${encodeURIComponent(r.invoice.clientId)}`} className="hover:underline">
                              {clientNameById[r.invoice.clientId] ?? r.invoice.clientId}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{r.invoice.dueDate ? formatDate(r.invoice.dueDate) : '—'}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs ${invoiceStatusBadgeClass(r.effectiveStatus)}`}>
                            {invoiceStatusLabel(r.effectiveStatus)}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-medium whitespace-nowrap">{formatMoney(r.balanceCents, getCurrencySymbol(settings.currencyCode))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 flex justify-end">
              <Link href="/admin/sales/invoices"><Button variant="outline" size="sm">View all invoices</Button></Link>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Recent payments (last 30 days)</CardTitle>
          <Link href="/admin/sales/payments"><Button variant="outline" size="sm">View all</Button></Link>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : dashboardData.recentPayments.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No recent payments.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-border">
                    <th className="py-2 pr-3 whitespace-nowrap">Date</th>
                    <th className="py-2 pr-3 whitespace-nowrap">Amount</th>
                    <th className="py-2 pr-3 min-w-[120px]">Client</th>
                    <th className="py-2 pr-3 whitespace-nowrap">Invoice</th>
                    <th className="py-2 pr-3 whitespace-nowrap">Method</th>
                    <th className="py-2 pr-3 whitespace-nowrap">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboardData.recentPayments.map((p) => (
                    <tr key={p.id} className="border-b border-border/60 last:border-b-0">
                      <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{formatDate(p.paymentDate)}</td>
                      <td className="py-2 pr-3 font-medium whitespace-nowrap">{formatMoney(p.amountCents, getCurrencySymbol(settings.currencyCode))}</td>
                      <td className="py-2 pr-3 text-muted-foreground min-w-[120px]">
                        {p.clientId ? (
                          <Link href={`/admin/clients/${encodeURIComponent(p.clientId)}`} className="hover:underline">
                            {clientNameById[p.clientId] ?? p.clientId}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                        {p.invoiceId ? (
                          <Link href={`/admin/sales/invoices/${encodeURIComponent(p.invoiceId)}`} className="hover:underline">
                            {dashboardData.invoiceNumberById[p.invoiceId] ?? p.invoiceId}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{p.method || '—'}</td>
                      <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{p.reference || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
