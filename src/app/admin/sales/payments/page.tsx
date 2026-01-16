'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ClientOption, SalesInvoice, SalesPayment } from '@/lib/sales/types'
import { fetchClientOptions } from '@/lib/sales/lookups'
import { centsToDollars, dollarsToCents, sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { ArrowDown, ArrowUp, Filter, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import {
  createSalesPayment,
  deleteSalesPayment,
  fetchSalesSettings,
  listSalesInvoices,
  listSalesPayments,
} from '@/lib/sales/admin-api'

type PaymentFilter = 'LINKED' | 'UNLINKED'

export default function SalesPaymentsPage() {
  const NONE = '__none__'
  const [tick, setTick] = useState(0)
  const [clients, setClients] = useState<ClientOption[]>([])
  const [loadingClients, setLoadingClients] = useState(true)

  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [invoices, setInvoices] = useState<SalesInvoice[]>([])
  const [payments, setPayments] = useState<SalesPayment[]>([])
  const [taxRatePercent, setTaxRatePercent] = useState<number>(0)

  const [filterSelected, setFilterSelected] = useState<Set<PaymentFilter>>(new Set())
  const [tableSortKey, setTableSortKey] = useState<'paymentDate' | 'amount' | 'method' | 'reference' | 'client' | 'invoice'>(
    'paymentDate'
  )
  const [tableSortDirection, setTableSortDirection] = useState<'asc' | 'desc'>('desc')
  const [recordsPerPage, setRecordsPerPage] = useState<20 | 50 | 100>(20)
  const [tablePage, setTablePage] = useState(1)

  const [paymentDate, setPaymentDate] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [clientId, setClientId] = useState<string>('')
  const [invoiceId, setInvoiceId] = useState<string>('')
  const [amount, setAmount] = useState<string>('')
  const [method, setMethod] = useState<string>('Bank transfer')
  const [reference, setReference] = useState<string>('')
  const [stripePaidCentsByInvoiceId, setStripePaidCentsByInvoiceId] = useState<Record<string, number>>({})
  const [stripePayments, setStripePayments] = useState<SalesPayment[]>([])

  useEffect(() => {
    const run = async () => {
      try {
        const c = await fetchClientOptions()
        setClients(c)
      } finally {
        setLoadingClients(false)
      }
    }
    void run()
  }, [])

  useEffect(() => {
    const onFocus = () => setTick((v) => v + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        setLoading(true)
        const [settings, invs, pays] = await Promise.all([
          fetchSalesSettings(),
          listSalesInvoices({ limit: 500 }),
          listSalesPayments({ limit: 500 }),
        ])

        if (cancelled) return
        setTaxRatePercent(settings.taxRatePercent)
        setInvoices(invs)
        setPayments(pays)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    const stored = localStorage.getItem('admin_sales_payments_filter')
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return
      const valid = new Set<PaymentFilter>(['LINKED', 'UNLINKED'])
      const next = new Set<PaymentFilter>()
      parsed.forEach((v) => {
        if (typeof v === 'string' && valid.has(v as PaymentFilter)) next.add(v as PaymentFilter)
      })
      if (next.size > 0) setFilterSelected(next)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('admin_sales_payments_filter', JSON.stringify([...filterSelected]))
  }, [filterSelected])

  useEffect(() => {
    let cancelled = false
    async function run() {
      const ids = invoices.map((i) => i.id).filter((id) => typeof id === 'string' && id.trim())
      if (!ids.length) {
        if (!cancelled) setStripePaidCentsByInvoiceId({})
        if (!cancelled) setStripePayments([])
        return
      }

      try {
        const res = await apiFetch(`/api/admin/sales/stripe-payments?invoiceDocIds=${encodeURIComponent(ids.join(','))}&limit=500`, { cache: 'no-store' })
        if (!res.ok) return
        const json = (await res.json().catch(() => null)) as { payments?: unknown[] } | null
        const list = Array.isArray(json?.payments) ? json!.payments! : []

        const nextPaidByInvoiceId: Record<string, number> = {}
        const nextPayments: SalesPayment[] = []

        const invoiceById = new Map(invoices.map((inv) => [inv.id, inv]))

        for (const p of list as any[]) {
          const invoiceDocId = typeof p?.invoiceDocId === 'string' ? p.invoiceDocId : ''
          const invoiceAmountCents = Number(p?.invoiceAmountCents)
          if (!invoiceDocId || !Number.isFinite(invoiceAmountCents)) continue

          const normalizedInvoiceCents = Math.max(0, Math.trunc(invoiceAmountCents))
          nextPaidByInvoiceId[invoiceDocId] = (nextPaidByInvoiceId[invoiceDocId] ?? 0) + normalizedInvoiceCents

          const createdAt = typeof p?.createdAt === 'string' ? p.createdAt : new Date().toISOString()
          const ymd = /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : new Date().toISOString().slice(0, 10)

          const paymentIntentId = typeof p?.stripePaymentIntentId === 'string' && p.stripePaymentIntentId.trim()
            ? p.stripePaymentIntentId.trim()
            : null
          const sessionId = typeof p?.stripeCheckoutSessionId === 'string' && p.stripeCheckoutSessionId.trim()
            ? p.stripeCheckoutSessionId.trim()
            : null
          const invoiceNumber = typeof p?.invoiceNumber === 'string' ? p.invoiceNumber : ''

          const inv = invoiceById.get(invoiceDocId)
          const clientId = inv?.clientId ?? null

          const recordId = typeof p?.id === 'string' && p.id.trim() ? p.id.trim() : crypto.randomUUID()

          nextPayments.push({
            id: `stripe-payment-${recordId}`,
            paymentDate: ymd,
            amountCents: normalizedInvoiceCents,
            method: 'Stripe',
            reference: paymentIntentId ?? sessionId ?? (invoiceNumber ? `Stripe payment for ${invoiceNumber}` : 'Stripe payment'),
            clientId,
            invoiceId: invoiceDocId,
            createdAt,
          })
        }

        if (!cancelled) setStripePaidCentsByInvoiceId(nextPaidByInvoiceId)
        if (!cancelled) setStripePayments(nextPayments)
      } catch {
        // ignore
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [invoices])

  const displayPayments = useMemo(() => {
    const local = payments
    if (!stripePayments.length) return local
    const existingIds = new Set(local.map((p) => p.id))
    return [...local, ...stripePayments.filter((p) => !existingIds.has(p.id))]
  }, [payments, stripePayments])

  const isReadOnlyPayment = (p: SalesPayment): boolean => p.id.startsWith('stripe-payment-')

  const clientNameById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients])
  const invoiceNumberById = useMemo(() => Object.fromEntries(invoices.map((i) => [i.id, i.invoiceNumber])), [invoices])

  const invoiceTotals = useMemo(() => {
    const byId = new Map<string, { totalCents: number; paidCents: number; balanceCents: number }>()

    for (const inv of invoices) {
      const subtotal = sumLineItemsSubtotal(inv.items)
      const tax = sumLineItemsTax(inv.items, taxRatePercent)
      const total = subtotal + tax
      const localPaid = payments.filter((p) => p.invoiceId === inv.id).reduce((acc, p) => acc + p.amountCents, 0)
      const stripePaid = stripePaidCentsByInvoiceId[inv.id] ?? 0
      const paid = localPaid + stripePaid
      byId.set(inv.id, { totalCents: total, paidCents: paid, balanceCents: Math.max(0, total - paid) })
    }

    return byId
  }, [invoices, payments, stripePaidCentsByInvoiceId, taxRatePercent])

  const unpaidInvoices = useMemo(() => {
    return invoices.filter((inv) => (invoiceTotals.get(inv.id)?.balanceCents ?? 0) > 0)
  }, [invoiceTotals, invoices])

  const selectedInvoice: SalesInvoice | undefined = invoiceId ? invoices.find((i) => i.id === invoiceId) : undefined

  const onCreatePayment = async () => {
    if (creating) return
    const amountCents = dollarsToCents(amount)
    if (!amountCents || amountCents <= 0) {
      alert('Enter a payment amount.')
      return
    }

    try {
      setCreating(true)
      await createSalesPayment({
        paymentDate,
        amountCents,
        method,
        reference,
        clientId: clientId || null,
        invoiceId: invoiceId || null,
      })

      setAmount('')
      setReference('')
      setTick((v) => v + 1)
    } catch {
      alert('Failed to save payment.')
    } finally {
      setCreating(false)
    }
  }

  const onDelete = async (paymentId: string) => {
    if (!confirm('Delete this payment?')) return

    try {
      setDeletingId(paymentId)
      await deleteSalesPayment(paymentId)
      setTick((v) => v + 1)
    } catch {
      alert('Failed to delete payment.')
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => {
    setTablePage(1)
  }, [filterSelected, recordsPerPage, tableSortDirection, tableSortKey])

  const filteredPayments = useMemo(() => {
    if (filterSelected.size === 0) return displayPayments
    return displayPayments.filter((p) => {
      const linked = Boolean(p.invoiceId)
      if (linked && filterSelected.has('LINKED')) return true
      if (!linked && filterSelected.has('UNLINKED')) return true
      return false
    })
  }, [displayPayments, filterSelected])

  const sortedPayments = useMemo(() => {
    const dir = tableSortDirection === 'asc' ? 1 : -1
    const getClientName = (p: SalesPayment) => (p.clientId ? clientNameById[p.clientId] ?? p.clientId : '')
    const getInvoiceNumber = (p: SalesPayment) => (p.invoiceId ? invoiceNumberById[p.invoiceId] ?? p.invoiceId : '')

    return [...filteredPayments].sort((a, b) => {
      if (tableSortKey === 'paymentDate') return dir * String(a.paymentDate || '').localeCompare(String(b.paymentDate || ''))
      if (tableSortKey === 'amount') return dir * (a.amountCents - b.amountCents)
      if (tableSortKey === 'method') return dir * String(a.method || '').localeCompare(String(b.method || ''))
      if (tableSortKey === 'reference') return dir * String(a.reference || '').localeCompare(String(b.reference || ''))
      if (tableSortKey === 'client') return dir * getClientName(a).localeCompare(getClientName(b))
      if (tableSortKey === 'invoice') return dir * getInvoiceNumber(a).localeCompare(getInvoiceNumber(b))
      return 0
    })
  }, [clientNameById, filteredPayments, invoiceNumberById, tableSortDirection, tableSortKey])

  const tableTotalPages = useMemo(
    () => Math.max(1, Math.ceil(sortedPayments.length / recordsPerPage)),
    [recordsPerPage, sortedPayments.length]
  )

  useEffect(() => {
    setTablePage((p) => Math.min(Math.max(1, p), tableTotalPages))
  }, [tableTotalPages])

  const visiblePayments = useMemo(() => {
    const start = (tablePage - 1) * recordsPerPage
    const end = start + recordsPerPage
    return sortedPayments.slice(start, end)
  }, [recordsPerPage, sortedPayments, tablePage])

  const toggleTableSort = (key: typeof tableSortKey) => {
    setTablePage(1)
    setTableSortKey((prev) => {
      if (prev !== key) {
        setTableSortDirection('asc')
        return key
      }
      setTableSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
      return prev
    })
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Payments</h2>
        <p className="text-sm text-muted-foreground">Record payments and link them to invoices.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Record a payment</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>Date</Label>
            <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="h-9" />
          </div>

          <div className="space-y-2">
            <Label>Client</Label>
            <Select value={clientId} onValueChange={(v) => setClientId(v === NONE ? '' : v)}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={loadingClients ? 'Loading…' : 'Select client'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>(none)</SelectItem>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Invoice</Label>
            <Select
              value={invoiceId}
              onValueChange={(v) => {
                const nextId = v === NONE ? '' : v
                setInvoiceId(nextId)
                if (nextId) {
                  const inv = invoices.find((i) => i.id === nextId)
                  if (inv?.clientId) setClientId(inv.clientId)
                }
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue
                  placeholder={
                    loading
                      ? 'Loading…'
                      : unpaidInvoices.length
                        ? 'Select invoice'
                        : 'No unpaid invoices'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>(none)</SelectItem>
                {unpaidInvoices.map((inv) => {
                  const bal = invoiceTotals.get(inv.id)?.balanceCents ?? 0
                  return (
                    <SelectItem key={inv.id} value={inv.id}>
                      {inv.invoiceNumber} — ${centsToDollars(bal)}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            {selectedInvoice && (
              <div className="text-xs text-muted-foreground">
                Selected: {selectedInvoice.invoiceNumber} ({selectedInvoice.status})
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Amount ($)</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="h-9" />
          </div>

          <div className="space-y-2">
            <Label>Method</Label>
            <Input value={method} onChange={(e) => setMethod(e.target.value)} className="h-9" />
          </div>

          <div className="space-y-2">
            <Label>Reference</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Receipt / txn id" className="h-9" />
          </div>

          <div className="lg:col-span-3 flex justify-end">
            <Button
              variant="default"
              onClick={onCreatePayment}
              disabled={creating || loading}
            >
              {creating ? 'Saving…' : 'Save payment'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">Payment history</CardTitle>
            <div className="flex items-center gap-2">
              <Select
                value={String(recordsPerPage)}
                onValueChange={(v) => {
                  const parsed = Number(v)
                  if (parsed === 20 || parsed === 50 || parsed === 100) setRecordsPerPage(parsed)
                }}
              >
                <SelectTrigger className="h-9 w-[88px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant={filterSelected.size > 0 ? 'default' : 'ghost'}
                    size="sm"
                    className={cn(
                      'inline-flex items-center',
                      filterSelected.size > 0 ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="Filter payments"
                    title="Filter payments"
                  >
                    <Filter className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Filter</DropdownMenuLabel>
                  {([
                    { key: 'LINKED' as const, label: 'Linked to invoice' },
                    { key: 'UNLINKED' as const, label: 'Unlinked' },
                  ] as const).map((opt) => {
                    const checked = filterSelected.has(opt.key)
                    return (
                      <DropdownMenuCheckboxItem
                        key={opt.key}
                        checked={checked}
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={() => {
                          setFilterSelected((prev) => {
                            const next = new Set(prev)
                            if (next.has(opt.key)) next.delete(opt.key)
                            else next.add(opt.key)
                            return next
                          })
                        }}
                      >
                        {opt.label}
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">Loading…</div>
          ) : displayPayments.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">No payments yet.</div>
          ) : (
            <div className="rounded-md border border-border bg-card overflow-hidden">
              <div className="w-full overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr className="border-b border-border">
                      {(
                        [
                          { key: 'paymentDate', label: 'Date', className: 'min-w-[120px]' },
                          { key: 'amount', label: 'Amount', className: 'min-w-[120px]' },
                          { key: 'method', label: 'Method', className: 'min-w-[140px]' },
                          { key: 'reference', label: 'Reference', className: 'min-w-[180px]' },
                          { key: 'client', label: 'Client', className: 'min-w-[180px]' },
                          { key: 'invoice', label: 'Invoice', className: 'min-w-[140px]' },
                        ] as const
                      ).map((col) => (
                        <th
                          key={col.key}
                          scope="col"
                          className={cn('px-3 py-2 text-left text-xs font-medium text-muted-foreground', col.className)}
                        >
                          <button
                            type="button"
                            onClick={() => toggleTableSort(col.key)}
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            title="Sort"
                          >
                            <span>{col.label}</span>
                            {tableSortKey === col.key && (
                              tableSortDirection === 'asc'
                                ? <ArrowUp className="h-3.5 w-3.5" />
                                : <ArrowDown className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </th>
                      ))}
                      <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground min-w-[110px]">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePayments.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                          No payments found.
                        </td>
                      </tr>
                    ) : (
                      visiblePayments.map((p) => (
                        <tr key={p.id} className="border-b border-border last:border-b-0 hover:bg-muted/40">
                          <td className="px-3 py-2 tabular-nums">{p.paymentDate}</td>
                          <td className="px-3 py-2 tabular-nums font-medium">${centsToDollars(p.amountCents)}</td>
                          <td className="px-3 py-2 text-muted-foreground">{p.method || '—'}</td>
                          <td className="px-3 py-2 text-muted-foreground">{p.reference || '—'}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {p.clientId ? (
                              <Link href={`/admin/clients/${p.clientId}`} className="hover:underline">
                                {clientNameById[p.clientId] ?? p.clientId}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {p.invoiceId ? (
                              <Link href={`/admin/sales/invoices/${p.invoiceId}`} className="hover:underline">
                                {invoiceNumberById[p.invoiceId] ?? p.invoiceId}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex justify-end">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 w-9 p-0"
                                onClick={() => onDelete(p.id)}
                                disabled={isReadOnlyPayment(p) || deletingId === p.id}
                                title={isReadOnlyPayment(p) ? 'Stripe payments are read-only' : 'Delete'}
                                aria-label={isReadOnlyPayment(p) ? 'Read-only payment' : 'Delete'}
                              >
                                <Trash2 className="w-4 h-4 text-destructive" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {tableTotalPages > 1 && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border bg-card">
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Page {tablePage} of {tableTotalPages}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setTablePage((p) => Math.max(1, p - 1))}
                      disabled={tablePage === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setTablePage((p) => Math.min(tableTotalPages, p + 1))}
                      disabled={tablePage === tableTotalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
