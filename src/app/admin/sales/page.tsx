'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  fetchSalesSettings,
  listSalesInvoices,
  listSalesPayments,
  listSalesQuotes,
} from '@/lib/sales/admin-api'
import type { SalesInvoiceWithVersion, SalesQuoteWithVersion } from '@/lib/sales/admin-api'
import type { InvoiceStatus, QuoteStatus, SalesPayment, SalesSettings } from '@/lib/sales/types'
import { fetchClientOptions } from '@/lib/sales/lookups'
import { centsToDollars, sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { endOfDayLocal, invoiceEffectiveStatus, parseDateOnlyLocal, quoteEffectiveStatus } from '@/lib/sales/status'

function quoteStatusBadgeClass(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20'
    case 'SENT':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20'
    case 'ACCEPTED':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
    case 'CLOSED':
      return 'bg-muted text-muted-foreground border border-border'
  }
}

function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'SENT':
      return 'Sent'
    case 'ACCEPTED':
      return 'Accepted'
    case 'CLOSED':
      return 'Closed'
  }
}

function invoiceStatusBadgeClass(status: InvoiceStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20'
    case 'SENT':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20'
    case 'OVERDUE':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20'
    case 'PARTIALLY_PAID':
      return 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/20'
    case 'PAID':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
  }
}

function invoiceStatusLabel(status: InvoiceStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'SENT':
      return 'Sent'
    case 'OVERDUE':
      return 'Overdue'
    case 'PARTIALLY_PAID':
      return 'Partially Paid'
    case 'PAID':
      return 'Paid'
  }
}

export default function SalesDashboardPage() {
  const [tick, setTick] = useState(0)
  const [nowIso, setNowIso] = useState<string | null>(null)
  const [clientNameById, setClientNameById] = useState<Record<string, string>>({})

  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState<SalesSettings>({
    businessName: '',
    address: '',
    abn: '',
    phone: '',
    email: '',
    website: '',
    taxRatePercent: 10,
    defaultQuoteValidDays: 14,
    defaultInvoiceDueDays: 7,
    defaultTerms: '',
    paymentDetails: '',
    updatedAt: new Date(0).toISOString(),
  })
  const [quotes, setQuotes] = useState<SalesQuoteWithVersion[]>([])
  const [invoices, setInvoices] = useState<SalesInvoiceWithVersion[]>([])
  const [payments, setPayments] = useState<SalesPayment[]>([])

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
        const [s, q, inv, pay] = await Promise.all([
          fetchSalesSettings(),
          listSalesQuotes(),
          listSalesInvoices(),
          listSalesPayments(),
        ])
        if (cancelled) return
        setSettings(s)
        setQuotes(q)
        setInvoices(inv)
        setPayments(pay)
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

  const stats = useMemo(() => {
    const nowMs = nowIso ? new Date(nowIso).getTime() : 0

    const openQuotes = quotes.filter((q) => {
      const st = quoteEffectiveStatus(q, nowMs)
      return st === 'OPEN' || st === 'SENT'
    }).length

    const openQuoteDrafts = quotes.filter((q) => quoteEffectiveStatus(q, nowMs) === 'OPEN').length

    const invoiceTotals = invoices.map((inv) => {
      const subtotal = sumLineItemsSubtotal(inv.items)
      const tax = sumLineItemsTax(inv.items, settings.taxRatePercent)
      const total = subtotal + tax
      const paid = payments
        .filter((p) => p.invoiceId === inv.id)
        .reduce((pAcc, p) => pAcc + p.amountCents, 0)
      const balance = Math.max(0, total - paid)

      const effectiveStatus = invoiceEffectiveStatus(
        {
          status: inv.status,
          sentAt: inv.sentAt,
          dueDate: inv.dueDate,
          totalCents: total,
          paidCents: paid,
        },
        nowMs
      )

      return { inv, total, paid, balance, effectiveStatus }
    })

    const openInvoices = invoiceTotals.filter((e) => e.effectiveStatus !== 'PAID')
    const overdueInvoices = invoiceTotals.filter((e) => e.effectiveStatus === 'OVERDUE')

    const openBalanceCents = openInvoices.reduce((acc, e) => acc + e.balance, 0)

    return {
      openQuotes,
      openQuoteDrafts,
      openInvoices: openInvoices.length,
      overdueInvoices: overdueInvoices.length,
      openBalanceCents,
    }
  }, [invoices, nowIso, payments, quotes, settings.taxRatePercent])

  const dashboardData = useMemo(() => {
    const nowMs = nowIso ? new Date(nowIso).getTime() : 0

    const quoteRows = quotes
      .map((q) => {
        const validUntil = parseDateOnlyLocal(q.validUntil)
        const isExpired = Boolean(validUntil) && nowMs > endOfDayLocal(validUntil as Date).getTime()
        const effectiveStatus: QuoteStatus = (q.status === 'CLOSED' || q.status === 'ACCEPTED')
          ? q.status
          : isExpired
            ? 'CLOSED'
            : q.status

        const subtotal = sumLineItemsSubtotal(q.items)
        const tax = sumLineItemsTax(q.items, settings.taxRatePercent)
        const total = subtotal + tax

        return { quote: q, effectiveStatus, totalCents: total }
      })
      .filter((r) => r.effectiveStatus === 'OPEN' || r.effectiveStatus === 'SENT')
      .sort((a, b) => b.quote.issueDate.localeCompare(a.quote.issueDate))
      .slice(0, 10)

    const invoiceRows = invoices
      .map((inv) => {
        const subtotal = sumLineItemsSubtotal(inv.items)
        const tax = sumLineItemsTax(inv.items, settings.taxRatePercent)
        const total = subtotal + tax
        const paid = payments.filter((p) => p.invoiceId === inv.id).reduce((acc, p) => acc + p.amountCents, 0)
        const balance = Math.max(0, total - paid)

        const due = parseDateOnlyLocal(inv.dueDate)
        const isPastDue = Boolean(due) && nowMs > endOfDayLocal(due as Date).getTime()
        const baseStatus: InvoiceStatus = inv.sentAt ? 'SENT' : 'OPEN'
        const effectiveStatus: InvoiceStatus = balance <= 0
          ? 'PAID'
          : isPastDue
            ? 'OVERDUE'
            : paid > 0
              ? 'PARTIALLY_PAID'
              : baseStatus

        return { invoice: inv, effectiveStatus, balanceCents: balance }
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
        const d = parseDateOnlyLocal(p.paymentDate)
        return Boolean(d) && (d as Date).getTime() >= thresholdMs
      })
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))
      .slice(0, 10)

    const invoiceNumberById = Object.fromEntries(invoices.map((i) => [i.id, i.invoiceNumber]))

    return { quoteRows, invoiceRows, recentPayments, invoiceNumberById }
  }, [invoices, nowIso, payments, quotes, settings.taxRatePercent])

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Open quotes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.openQuotes}</div>
            <div className="text-xs text-muted-foreground mt-1">{stats.openQuoteDrafts} draft</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Open invoices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.openInvoices}</div>
            <div className="text-xs text-muted-foreground mt-1">{stats.overdueInvoices} overdue</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Outstanding balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${centsToDollars(stats.openBalanceCents)}</div>
            <div className="text-xs text-muted-foreground mt-1">Across open/sent/overdue invoices</div>
          </CardContent>
        </Card>
      </div>

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
                      <th className="py-2 pr-3">Quote</th>
                      <th className="py-2 pr-3">Client</th>
                      <th className="py-2 pr-3">Issue date</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardData.quoteRows.map((r) => (
                      <tr key={r.quote.id} className="border-b border-border/60 last:border-b-0">
                        <td className="py-2 pr-3 font-medium">
                          <Link href={`/admin/sales/quotes/${encodeURIComponent(r.quote.id)}`} className="hover:underline">
                            {r.quote.quoteNumber}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {r.quote.clientId ? (
                            <Link href={`/admin/clients/${encodeURIComponent(r.quote.clientId)}`} className="hover:underline">
                              {clientNameById[r.quote.clientId] ?? r.quote.clientId}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{r.quote.issueDate}</td>
                        <td className="py-2 pr-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs ${quoteStatusBadgeClass(r.effectiveStatus)}`}>
                            {quoteStatusLabel(r.effectiveStatus)}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-medium">${centsToDollars(r.totalCents)}</td>
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
                      <th className="py-2 pr-3">Invoice</th>
                      <th className="py-2 pr-3">Client</th>
                      <th className="py-2 pr-3">Due date</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardData.invoiceRows.map((r) => (
                      <tr key={r.invoice.id} className="border-b border-border/60 last:border-b-0">
                        <td className="py-2 pr-3 font-medium">
                          <Link href={`/admin/sales/invoices/${encodeURIComponent(r.invoice.id)}`} className="hover:underline">
                            {r.invoice.invoiceNumber}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {r.invoice.clientId ? (
                            <Link href={`/admin/clients/${encodeURIComponent(r.invoice.clientId)}`} className="hover:underline">
                              {clientNameById[r.invoice.clientId] ?? r.invoice.clientId}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{r.invoice.dueDate ?? '—'}</td>
                        <td className="py-2 pr-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs ${invoiceStatusBadgeClass(r.effectiveStatus)}`}>
                            {invoiceStatusLabel(r.effectiveStatus)}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-medium">${centsToDollars(r.balanceCents)}</td>
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
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Amount</th>
                    <th className="py-2 pr-3">Client</th>
                    <th className="py-2 pr-3">Invoice</th>
                    <th className="py-2 pr-3">Method</th>
                    <th className="py-2 pr-3">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboardData.recentPayments.map((p) => (
                    <tr key={p.id} className="border-b border-border/60 last:border-b-0">
                      <td className="py-2 pr-3 text-muted-foreground">{p.paymentDate}</td>
                      <td className="py-2 pr-3 font-medium">${centsToDollars(p.amountCents)}</td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {p.clientId ? (
                          <Link href={`/admin/clients/${encodeURIComponent(p.clientId)}`} className="hover:underline">
                            {clientNameById[p.clientId] ?? p.clientId}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {p.invoiceId ? (
                          <Link href={`/admin/sales/invoices/${encodeURIComponent(p.invoiceId)}`} className="hover:underline">
                            {dashboardData.invoiceNumberById[p.invoiceId] ?? p.invoiceId}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{p.method || '—'}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{p.reference || '—'}</td>
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
