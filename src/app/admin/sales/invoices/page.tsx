'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  deleteSalesInvoice,
  fetchSalesInvoice,
  fetchSalesRollup,
  fetchSalesSettings,
  patchSalesInvoice,
} from '@/lib/sales/admin-api'
import type { SalesInvoiceWithVersion, SalesRollupResponse } from '@/lib/sales/admin-api'
import type { InvoiceStatus, SalesSettings } from '@/lib/sales/types'
import { centsToDollars, formatMoney, sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { fetchClientDetails, fetchClientOptions, fetchProjectOptions } from '@/lib/sales/lookups'
import { downloadInvoicePdf } from '@/lib/sales/pdf'
import { ArrowDown, ArrowUp, Download, Eye, Filter, Send, Trash2 } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { createSalesDocShareUrl } from '@/lib/sales/public-share'
import { SalesSendEmailDialog } from '@/components/admin/sales/SalesSendEmailDialog'
import { apiFetch } from '@/lib/api-client'
import { SalesRemindersBellButton } from '@/components/admin/sales/SalesRemindersBellButton'
import { invoiceEffectiveStatus as computeInvoiceEffectiveStatus } from '@/lib/sales/status'

type InvoiceRow = {
  invoice: SalesInvoiceWithVersion
  effectiveStatus: InvoiceStatus
  totalCents: number
}

function statusBadgeClass(status: InvoiceStatus): string {
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

function statusLabel(status: InvoiceStatus): string {
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

export default function SalesInvoicesPage() {
  const [tick, setTick] = useState(0)
  const [nowIso, setNowIso] = useState<string | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [sendTarget, setSendTarget] = useState<SalesInvoiceWithVersion | null>(null)
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState<SalesSettings>({
    businessName: '',
    address: '',
    abn: '',
    phone: '',
    email: '',
    website: '',
    businessRegistrationLabel: 'ABN',
    currencySymbol: '$',
    currencyCode: 'AUD',
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
  const [invoices, setInvoices] = useState<SalesInvoiceWithVersion[]>([])
  const [rollup, setRollup] = useState<SalesRollupResponse | null>(null)
  const [clientNameById, setClientNameById] = useState<Record<string, string>>({})
  const [projectTitleById, setProjectTitleById] = useState<Record<string, string>>({})
  const [statusFilterSelected, setStatusFilterSelected] = useState<Set<InvoiceStatus>>(new Set())
  const [tableSortKey, setTableSortKey] = useState<
    'invoiceNumber' | 'issueDate' | 'dueDate' | 'status' | 'amount' | 'client' | 'project'
  >('issueDate')
  const [tableSortDirection, setTableSortDirection] = useState<'asc' | 'desc'>('desc')
  const [recordsPerPage, setRecordsPerPage] = useState<20 | 50 | 100>(20)
  const [tablePage, setTablePage] = useState(1)
  const [overdueInvoiceRemindersEnabled, setOverdueInvoiceRemindersEnabled] = useState<boolean | null>(null)

  useEffect(() => {
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
        const reminderResPromise = apiFetch('/api/admin/sales/reminder-settings', { method: 'GET' }).catch(() => null)
        const [s, r, reminderRes] = await Promise.all([
          fetchSalesSettings(),
          fetchSalesRollup({ invoicesLimit: 2000, paymentsLimit: 5000, stripePaymentsLimit: 500, includeQuotes: false }),
          reminderResPromise,
        ])
        if (cancelled) return
        setSettings(s)
        setInvoices(r.invoices)
        setRollup(r)

        if (reminderRes && 'ok' in reminderRes) {
          const json = await (reminderRes as Response).json().catch(() => null)
          setOverdueInvoiceRemindersEnabled((reminderRes as Response).ok ? Boolean((json as any)?.overdueInvoiceRemindersEnabled) : false)
        } else {
          setOverdueInvoiceRemindersEnabled(false)
        }
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

  const onToggleReminders = useCallback(
    async (inv: SalesInvoiceWithVersion) => {
      const enabled = (inv as any)?.remindersEnabled !== false
      try {
        const next = await patchSalesInvoice(inv.id, {
          version: inv.version,
          remindersEnabled: !enabled,
        })
        setInvoices((prev) => prev.map((x) => (x.id === next.id ? next : x)))
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to update invoice'
        if (msg === 'Conflict') {
          alert('This invoice was updated in another session. Reloading.')
          setTick((v) => v + 1)
          return
        }
        alert(msg)
      }
    },
    []
  )

  useEffect(() => {
    setNowIso(new Date().toISOString())
  }, [])

  useEffect(() => {
    const run = async () => {
      try {
        const [clients, projects] = await Promise.all([fetchClientOptions(), fetchProjectOptions()])
        setClientNameById(Object.fromEntries(clients.map((c) => [c.id, c.name])))
        setProjectTitleById(Object.fromEntries(projects.map((p) => [p.id, p.title])))
      } catch {
        // ignore
      }
    }
    void run()
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem('admin_sales_invoices_status_filter')
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return
      const valid = new Set<InvoiceStatus>(['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'])
      const next = new Set<InvoiceStatus>()
      parsed.forEach((v) => {
        if (typeof v === 'string' && valid.has(v as InvoiceStatus)) next.add(v as InvoiceStatus)
      })
      if (next.size > 0) setStatusFilterSelected(next)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('admin_sales_invoices_status_filter', JSON.stringify([...statusFilterSelected]))
  }, [statusFilterSelected])

  const taxRatePercent = settings.taxRatePercent

  const onDownload = async (inv: SalesInvoiceWithVersion) => {
    const clientDetails = inv.clientId ? await fetchClientDetails(inv.clientId).catch(() => null) : null
    let publicInvoiceUrl: string | undefined
    try {
      const r = rollup?.invoiceRollupById?.[inv.id]
      const totalCents = invoiceTotalCents(inv)
      const balanceCents = Number.isFinite(Number(r?.balanceCents)) ? Number(r!.balanceCents) : Math.max(0, totalCents)
      const invoicePaidAt = (totalCents > 0 && balanceCents <= 0)
        ? (r?.latestPaymentYmd ?? new Date().toISOString().slice(0, 10))
        : null

      publicInvoiceUrl = await createSalesDocShareUrl({
        type: 'INVOICE',
        doc: inv,
        settings,
        clientName: inv.clientId ? (clientNameById[inv.clientId] ?? undefined) : undefined,
        projectTitle: inv.projectId ? (projectTitleById[inv.projectId] ?? undefined) : undefined,
        invoicePaidAt,
      })
    } catch {
      // ignore; PDF should still download with payment details
    }
    await downloadInvoicePdf(inv, settings, {
      clientName: inv.clientId ? (clientNameById[inv.clientId] ?? undefined) : undefined,
      clientAddress: clientDetails?.address ?? undefined,
      projectTitle: inv.projectId ? (projectTitleById[inv.projectId] ?? undefined) : undefined,
      publicInvoiceUrl,
    })
  }

  const onView = async (inv: SalesInvoiceWithVersion) => {
    const r = rollup?.invoiceRollupById?.[inv.id]
    const totalCents = invoiceTotalCents(inv)
    const balanceCents = Number.isFinite(Number(r?.balanceCents)) ? Number(r!.balanceCents) : Math.max(0, totalCents)
    const invoicePaidAt = (totalCents > 0 && balanceCents <= 0)
      ? (r?.latestPaymentYmd ?? new Date().toISOString().slice(0, 10))
      : null

    const url = await createSalesDocShareUrl({
      type: 'INVOICE',
      doc: inv,
      settings,
      clientName: inv.clientId ? (clientNameById[inv.clientId] ?? undefined) : undefined,
      projectTitle: inv.projectId ? (projectTitleById[inv.projectId] ?? undefined) : undefined,
      invoicePaidAt,
    })
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const invoicePaidCents = useCallback(
    (inv: SalesInvoiceWithVersion): number => {
      const r = rollup?.invoiceRollupById?.[inv.id]
      const paid = Number(r?.paidCents)
      return Number.isFinite(paid) ? Math.max(0, Math.trunc(paid)) : 0
    },
    [rollup?.invoiceRollupById]
  )

  const invoiceTotalCents = useCallback(
    (inv: SalesInvoiceWithVersion): number => {
      const subtotal = sumLineItemsSubtotal(inv.items)
      const invTaxEnabled = typeof (inv as any)?.taxEnabled === 'boolean' ? (inv as any).taxEnabled : true
      const tax = invTaxEnabled ? sumLineItemsTax(inv.items, taxRatePercent) : 0
      return subtotal + tax
    },
    [taxRatePercent]
  )

  const getInvoiceEffectiveStatus = useCallback(
    (inv: SalesInvoiceWithVersion): InvoiceStatus => {
      const total = invoiceTotalCents(inv)
      const paid = invoicePaidCents(inv)
      const nowMs = nowIso ? new Date(nowIso).getTime() : 0
      return computeInvoiceEffectiveStatus({ status: inv.status, sentAt: inv.sentAt, dueDate: inv.dueDate, totalCents: total, paidCents: paid }, nowMs)
    },
    [invoicePaidCents, invoiceTotalCents, nowIso]
  )

  useEffect(() => {
    setTablePage(1)
  }, [recordsPerPage, tableSortDirection, tableSortKey, statusFilterSelected])

  const invoiceRows = useMemo((): InvoiceRow[] => {
    return invoices.map((inv) => {
      const effectiveStatus = getInvoiceEffectiveStatus(inv)
      return { invoice: inv, effectiveStatus, totalCents: invoiceTotalCents(inv) }
    })
  }, [getInvoiceEffectiveStatus, invoiceTotalCents, invoices])

  const filteredInvoices = useMemo(() => {
    if (statusFilterSelected.size === 0) return invoiceRows
    return invoiceRows.filter((r) => statusFilterSelected.has(r.effectiveStatus))
  }, [invoiceRows, statusFilterSelected])

  const sortedInvoices = useMemo(() => {
    const dir = tableSortDirection === 'asc' ? 1 : -1
    const getClientName = (inv: SalesInvoiceWithVersion) => (inv.clientId ? clientNameById[inv.clientId] ?? inv.clientId : '')
    const getProjectTitle = (inv: SalesInvoiceWithVersion) => (inv.projectId ? projectTitleById[inv.projectId] ?? inv.projectId : '')

    return [...filteredInvoices].sort((a, b) => {
      if (tableSortKey === 'invoiceNumber') return dir * String(a.invoice.invoiceNumber).localeCompare(String(b.invoice.invoiceNumber))
      if (tableSortKey === 'issueDate') return dir * String(a.invoice.issueDate || '').localeCompare(String(b.invoice.issueDate || ''))
      if (tableSortKey === 'dueDate') return dir * String(a.invoice.dueDate || '').localeCompare(String(b.invoice.dueDate || ''))
      if (tableSortKey === 'status') return dir * String(a.effectiveStatus).localeCompare(String(b.effectiveStatus))
      if (tableSortKey === 'amount') return dir * (a.totalCents - b.totalCents)
      if (tableSortKey === 'client') return dir * getClientName(a.invoice).localeCompare(getClientName(b.invoice))
      if (tableSortKey === 'project') return dir * getProjectTitle(a.invoice).localeCompare(getProjectTitle(b.invoice))
      return 0
    })
  }, [clientNameById, filteredInvoices, projectTitleById, tableSortDirection, tableSortKey])

  const tableTotalPages = useMemo(
    () => Math.max(1, Math.ceil(sortedInvoices.length / recordsPerPage)),
    [recordsPerPage, sortedInvoices.length]
  )

  useEffect(() => {
    setTablePage((p) => Math.min(Math.max(1, p), tableTotalPages))
  }, [tableTotalPages])

  const visibleInvoices = useMemo(() => {
    const start = (tablePage - 1) * recordsPerPage
    const end = start + recordsPerPage
    return sortedInvoices.slice(start, end)
  }, [recordsPerPage, sortedInvoices, tablePage])

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

  const onSend = (inv: SalesInvoiceWithVersion) => {
    if (!inv) return
    setSendTarget(inv)
    setSendOpen(true)
  }

  const onDelete = async (inv: SalesInvoiceWithVersion) => {
    if (!confirm(`Delete invoice ${inv.invoiceNumber}?`)) return
    try {
      await deleteSalesInvoice(inv.id)
      setInvoices((prev) => prev.filter((x) => x.id !== inv.id))
      if (sendTarget?.id === inv.id) {
        setSendOpen(false)
        setSendTarget(null)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to delete invoice'
      alert(msg)
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Invoices</h2>
          <p className="text-sm text-muted-foreground">Create, view, and send invoices.</p>
        </div>
        <Link href="/admin/sales/invoices/new">
          <Button variant="default">Create invoice</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1" />
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
                    variant={statusFilterSelected.size > 0 ? 'default' : 'ghost'}
                    size="sm"
                    className={cn(
                      'inline-flex items-center',
                      statusFilterSelected.size > 0 ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="Filter statuses"
                    title="Filter statuses"
                  >
                    <Filter className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Filter statuses</DropdownMenuLabel>
                  {(['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'] as const).map((s) => {
                    const checked = statusFilterSelected.has(s)
                    return (
                      <DropdownMenuCheckboxItem
                        key={s}
                        checked={checked}
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={() => {
                          setStatusFilterSelected((prev) => {
                            const next = new Set(prev)
                            if (next.has(s)) next.delete(s)
                            else next.add(s)
                            return next
                          })
                        }}
                      >
                        {statusLabel(s)}
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
          ) : invoices.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">No invoices yet.</div>
          ) : (
            <div className="rounded-md border border-border bg-card overflow-hidden">
              <div className="w-full overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr className="border-b border-border">
                      {(
                        [
                          { key: 'invoiceNumber', label: 'Invoice', className: 'min-w-[120px]' },
                          { key: 'issueDate', label: 'Issue date', className: 'min-w-[120px]' },
                          { key: 'dueDate', label: 'Due date', className: 'min-w-[120px]' },
                          { key: 'status', label: 'Status', className: 'min-w-[120px]' },
                          { key: 'amount', label: 'Amount', className: 'min-w-[120px]' },
                          { key: 'client', label: 'Client', className: 'min-w-[180px]' },
                          { key: 'project', label: 'Project', className: 'min-w-[200px]' },
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
                              tableSortDirection === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </th>
                      ))}
                      <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground min-w-[160px]">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInvoices.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                          No invoices found.
                        </td>
                      </tr>
                    ) : (
                      visibleInvoices.map((row) => (
                        <tr key={row.invoice.id} className="border-b border-border last:border-b-0 hover:bg-muted/40">
                          <td className="px-3 py-2 font-medium">
                            <Link href={`/admin/sales/invoices/${row.invoice.id}`} className="hover:underline">
                              {row.invoice.invoiceNumber}
                            </Link>
                          </td>
                          <td className="px-3 py-2 tabular-nums">{formatDate(row.invoice.issueDate)}</td>
                          <td className="px-3 py-2 tabular-nums">{row.invoice.dueDate ? formatDate(row.invoice.dueDate) : '—'}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs ${statusBadgeClass(row.effectiveStatus)}`}>
                              {statusLabel(row.effectiveStatus)}
                            </span>
                          </td>
                          <td className="px-3 py-2 tabular-nums">{formatMoney(row.totalCents, settings.currencySymbol)}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {row.invoice.clientId ? (
                              <Link href={`/admin/clients/${row.invoice.clientId}`} className="hover:underline">
                                {clientNameById[row.invoice.clientId] ?? row.invoice.clientId}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {row.invoice.projectId ? (
                              <Link href={`/admin/projects/${row.invoice.projectId}`} className="hover:underline">
                                {projectTitleById[row.invoice.projectId] ?? row.invoice.projectId}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex justify-end gap-2">
                              {overdueInvoiceRemindersEnabled ? (
                                <SalesRemindersBellButton
                                  enabled={(row.invoice as any)?.remindersEnabled !== false}
                                  onToggle={() => void onToggleReminders(row.invoice)}
                                />
                              ) : null}
                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                onClick={() => void onDownload(row.invoice)}
                                title="Download PDF"
                                aria-label="Download PDF"
                              >
                                <Download className="h-4 w-4" />
                              </Button>

                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                onClick={() => void onView(row.invoice)}
                                title="View"
                                aria-label="View"
                              >
                                <Eye className="h-4 w-4" />
                              </Button>

                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                onClick={() => onSend(row.invoice)}
                                title="Send"
                                aria-label="Send"
                              >
                                <Send className="h-4 w-4" />
                              </Button>

                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 w-9 p-0"
                                onClick={() => onDelete(row.invoice)}
                                title="Delete"
                                aria-label="Delete"
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

      {sendTarget ? (
        <SalesSendEmailDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          type="INVOICE"
          doc={sendTarget}
          settings={settings}
          clientName={sendTarget.clientId ? (clientNameById[sendTarget.clientId] ?? undefined) : undefined}
          projectTitle={sendTarget.projectId ? (projectTitleById[sendTarget.projectId] ?? undefined) : undefined}
          onSent={() => {
            ;(async () => {
              try {
                const next = await fetchSalesInvoice(sendTarget.id)
                setInvoices((prev) => prev.map((x) => (x.id === next.id ? next : x)))
                setSendTarget(next)
              } catch (e) {
                alert(e instanceof Error ? e.message : 'Failed to refresh invoice')
              }
            })()
          }}
        />
      ) : null}
    </div>
  )
}
