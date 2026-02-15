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
import { deleteSalesQuote, fetchSalesQuote, fetchSalesSettings, listSalesQuotes, patchSalesQuote } from '@/lib/sales/admin-api'
import type { SalesQuoteWithVersion } from '@/lib/sales/admin-api'
import type { QuoteStatus, SalesSettings } from '@/lib/sales/types'
import { fetchClientDetails, fetchClientOptions, fetchProjectOptions } from '@/lib/sales/lookups'
import { downloadQuotePdf } from '@/lib/sales/pdf'
import { centsToDollars, formatMoney, sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { getCurrencySymbol } from '@/lib/sales/currency'
import { ArrowDown, ArrowUp, BadgeCheck, Download, Eye, Filter, Send, Trash2 } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { createSalesDocShareUrl } from '@/lib/sales/public-share'
import { SalesSendEmailDialog } from '@/components/admin/sales/SalesSendEmailDialog'
import { apiFetch } from '@/lib/api-client'
import { SalesRemindersBellButton } from '@/components/admin/sales/SalesRemindersBellButton'
import { quoteEffectiveStatus } from '@/lib/sales/status'

type QuoteRow = {
  quote: SalesQuoteWithVersion
  effectiveStatus: QuoteStatus
  totalCents: number
}

function statusBadgeClass(status: QuoteStatus): string {
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

function statusLabel(status: QuoteStatus): string {
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

export default function SalesQuotesPage() {
  const [tick, setTick] = useState(0)
  const [nowIso, setNowIso] = useState<string | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [sendTarget, setSendTarget] = useState<SalesQuoteWithVersion | null>(null)
  const [loading, setLoading] = useState(true)
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
  const [quotes, setQuotes] = useState<SalesQuoteWithVersion[]>([])
  const [clientNameById, setClientNameById] = useState<Record<string, string>>({})
  const [projectTitleById, setProjectTitleById] = useState<Record<string, string>>({})
  const [statusFilterSelected, setStatusFilterSelected] = useState<Set<QuoteStatus>>(new Set())
  const [tableSortKey, setTableSortKey] = useState<
    'quoteNumber' | 'issueDate' | 'validUntil' | 'status' | 'amount' | 'client' | 'project'
  >(
    'issueDate'
  )
  const [tableSortDirection, setTableSortDirection] = useState<'asc' | 'desc'>('desc')
  const [recordsPerPage, setRecordsPerPage] = useState<20 | 50 | 100>(20)
  const [tablePage, setTablePage] = useState(1)
  const [quoteExpiryRemindersEnabled, setQuoteExpiryRemindersEnabled] = useState<boolean | null>(null)

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
        const [s, q, reminderRes] = await Promise.all([fetchSalesSettings(), listSalesQuotes(), reminderResPromise])
        if (cancelled) return
        setSettings(s)
        setQuotes(q)

        if (reminderRes && 'ok' in reminderRes) {
          const json = await (reminderRes as Response).json().catch(() => null)
          setQuoteExpiryRemindersEnabled((reminderRes as Response).ok ? Boolean((json as any)?.quoteExpiryRemindersEnabled) : false)
        } else {
          setQuoteExpiryRemindersEnabled(false)
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
    async (q: SalesQuoteWithVersion) => {
      const enabled = (q as any)?.remindersEnabled !== false
      try {
        const next = await patchSalesQuote(q.id, {
          version: q.version,
          remindersEnabled: !enabled,
        })
        setQuotes((prev) => prev.map((x) => (x.id === next.id ? next : x)))
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to update quote'
        if (msg === 'Conflict') {
          alert('This quote was updated in another session. Reloading.')
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
    const stored = localStorage.getItem('admin_sales_quotes_status_filter')
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return
      const valid = new Set<QuoteStatus>(['OPEN', 'SENT', 'ACCEPTED', 'CLOSED'])
      const next = new Set<QuoteStatus>()
      parsed.forEach((v) => {
        if (typeof v === 'string' && valid.has(v as QuoteStatus)) next.add(v as QuoteStatus)
      })
      if (next.size > 0) setStatusFilterSelected(next)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('admin_sales_quotes_status_filter', JSON.stringify([...statusFilterSelected]))
  }, [statusFilterSelected])

  useEffect(() => {
    setTablePage(1)
  }, [recordsPerPage, tableSortDirection, tableSortKey, statusFilterSelected])

  const quoteTotalCents = useCallback(
    (q: SalesQuoteWithVersion): number => {
      const subtotal = sumLineItemsSubtotal(q.items)
      const qTaxEnabled = typeof (q as any)?.taxEnabled === 'boolean' ? (q as any).taxEnabled : true
      const tax = qTaxEnabled ? sumLineItemsTax(q.items, settings.taxRatePercent) : 0
      return subtotal + tax
    },
    [settings.taxRatePercent]
  )

  const quoteEffectiveStatusForRow = useCallback(
    (q: SalesQuoteWithVersion): QuoteStatus => {
      const nowMs = nowIso ? new Date(nowIso).getTime() : 0
      return quoteEffectiveStatus(q, nowMs)
    },
    [nowIso]
  )

  const quoteRows = useMemo((): QuoteRow[] => {
    return quotes.map((q) => ({ quote: q, effectiveStatus: quoteEffectiveStatusForRow(q), totalCents: quoteTotalCents(q) }))
  }, [quoteEffectiveStatusForRow, quoteTotalCents, quotes])

  const filteredQuotes = useMemo(() => {
    if (statusFilterSelected.size === 0) return quoteRows
    return quoteRows.filter((r) => statusFilterSelected.has(r.effectiveStatus))
  }, [quoteRows, statusFilterSelected])

  const sortedQuotes = useMemo(() => {
    const dir = tableSortDirection === 'asc' ? 1 : -1
    const getClientName = (q: SalesQuoteWithVersion) => (q.clientId ? clientNameById[q.clientId] ?? q.clientId : '')
    const getProjectTitle = (q: SalesQuoteWithVersion) => (q.projectId ? projectTitleById[q.projectId] ?? q.projectId : '')

    return [...filteredQuotes].sort((a, b) => {
      if (tableSortKey === 'quoteNumber') return dir * String(a.quote.quoteNumber).localeCompare(String(b.quote.quoteNumber))
      if (tableSortKey === 'issueDate') return dir * String(a.quote.issueDate || '').localeCompare(String(b.quote.issueDate || ''))
      if (tableSortKey === 'validUntil') return dir * String(a.quote.validUntil || '').localeCompare(String(b.quote.validUntil || ''))
      if (tableSortKey === 'status') return dir * String(a.effectiveStatus).localeCompare(String(b.effectiveStatus))
      if (tableSortKey === 'amount') return dir * (a.totalCents - b.totalCents)
      if (tableSortKey === 'client') return dir * getClientName(a.quote).localeCompare(getClientName(b.quote))
      if (tableSortKey === 'project') return dir * getProjectTitle(a.quote).localeCompare(getProjectTitle(b.quote))
      return 0
    })
  }, [clientNameById, filteredQuotes, projectTitleById, tableSortDirection, tableSortKey])

  const tableTotalPages = useMemo(() => Math.max(1, Math.ceil(sortedQuotes.length / recordsPerPage)), [recordsPerPage, sortedQuotes.length])

  useEffect(() => {
    setTablePage((p) => Math.min(Math.max(1, p), tableTotalPages))
  }, [tableTotalPages])

  const visibleQuotes = useMemo(() => {
    const start = (tablePage - 1) * recordsPerPage
    const end = start + recordsPerPage
    return sortedQuotes.slice(start, end)
  }, [recordsPerPage, sortedQuotes, tablePage])

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

  const onSend = (q: SalesQuoteWithVersion) => {
    if (!q) return
    setSendTarget(q)
    setSendOpen(true)
  }

  const onAccept = async (q: SalesQuoteWithVersion) => {
    try {
      const next =
        q.status === 'ACCEPTED'
          ? await patchSalesQuote(q.id, {
              status: q.acceptedFromStatus ?? 'OPEN',
              acceptedFromStatus: null,
              version: q.version,
            })
          : await patchSalesQuote(q.id, {
              status: 'ACCEPTED',
              acceptedFromStatus: q.status,
              version: q.version,
            })

      setQuotes((prev) => prev.map((x) => (x.id === next.id ? next : x)))
      setSendTarget((prev) => (prev?.id === next.id ? next : prev))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to update quote'
      if (msg === 'Conflict') {
        alert('This quote was updated in another session. Reloading.')
        setTick((v) => v + 1)
        return
      }
      alert(msg)
    }
  }

  const onDelete = async (q: SalesQuoteWithVersion) => {
    if (!confirm(`Delete quote ${q.quoteNumber}?`)) return
    try {
      await deleteSalesQuote(q.id)
      setQuotes((prev) => prev.filter((x) => x.id !== q.id))
      if (sendTarget?.id === q.id) {
        setSendOpen(false)
        setSendTarget(null)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to delete quote'
      alert(msg)
    }
  }

  const onDownload = async (q: SalesQuoteWithVersion) => {
    const clientDetails = q.clientId ? await fetchClientDetails(q.clientId).catch(() => null) : null

    const publicQuoteUrl = await createSalesDocShareUrl({
      type: 'QUOTE',
      doc: q,
      settings,
      clientName: q.clientId ? (clientNameById[q.clientId] ?? undefined) : undefined,
      projectTitle: q.projectId ? (projectTitleById[q.projectId] ?? undefined) : undefined,
    })

    await downloadQuotePdf(q, settings, {
      clientName: q.clientId ? (clientNameById[q.clientId] ?? undefined) : undefined,
      clientAddress: clientDetails?.address ?? undefined,
      projectTitle: q.projectId ? (projectTitleById[q.projectId] ?? undefined) : undefined,
      publicQuoteUrl,
    })
  }

  const onView = async (q: SalesQuoteWithVersion) => {
    const url = await createSalesDocShareUrl({
      type: 'QUOTE',
      doc: q,
      settings,
      clientName: q.clientId ? (clientNameById[q.clientId] ?? undefined) : undefined,
      projectTitle: q.projectId ? (projectTitleById[q.projectId] ?? undefined) : undefined,
    })
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Quotes</h2>
          <p className="text-sm text-muted-foreground">Create, view, and send quotes.</p>
        </div>
        <Link href="/admin/sales/quotes/new">
          <Button variant="default">Create quote</Button>
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
                      statusFilterSelected.size > 0 ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="Filter statuses"
                    title="Filter statuses"
                  >
                    <Filter className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Filter statuses</DropdownMenuLabel>
                  {(['OPEN', 'SENT', 'ACCEPTED', 'CLOSED'] as const).map((s) => {
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
          ) : quotes.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">No quotes yet.</div>
          ) : (
            <div className="rounded-md border border-border bg-card overflow-hidden">
              <div className="w-full overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr className="border-b border-border">
                      {(
                        [
                          { key: 'quoteNumber', label: 'Quote', className: 'min-w-[120px]' },
                          { key: 'issueDate', label: 'Issue date', className: 'min-w-[120px]' },
                          { key: 'validUntil', label: 'Expiry', className: 'min-w-[120px]' },
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
                      <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground min-w-[140px]">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleQuotes.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                          No quotes found.
                        </td>
                      </tr>
                    ) : (
                      visibleQuotes.map((row) => (
                        <tr key={row.quote.id} className="border-b border-border last:border-b-0 hover:bg-muted/40">
                          <td className="px-3 py-2 font-medium">
                            <Link href={`/admin/sales/quotes/${row.quote.id}`} className="hover:underline">
                              {row.quote.quoteNumber}
                            </Link>
                          </td>
                          <td className="px-3 py-2 tabular-nums">{formatDate(row.quote.issueDate)}</td>
                          <td className="px-3 py-2 tabular-nums">{row.quote.validUntil ? formatDate(row.quote.validUntil) : '—'}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs ${statusBadgeClass(row.effectiveStatus)}`}>
                              {statusLabel(row.effectiveStatus)}
                            </span>
                          </td>
                          <td className="px-3 py-2 tabular-nums">{formatMoney(row.totalCents, getCurrencySymbol(settings.currencyCode))}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {row.quote.clientId ? (
                              <Link href={`/admin/clients/${row.quote.clientId}`} className="hover:underline">
                                {clientNameById[row.quote.clientId] ?? row.quote.clientId}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {row.quote.projectId ? (
                              <Link href={`/admin/projects/${row.quote.projectId}`} className="hover:underline">
                                {projectTitleById[row.quote.projectId] ?? row.quote.projectId}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex justify-end gap-2">
                              {quoteExpiryRemindersEnabled ? (
                                <SalesRemindersBellButton
                                  enabled={(row.quote as any)?.remindersEnabled !== false}
                                  onToggle={() => void onToggleReminders(row.quote)}
                                />
                              ) : null}
                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                onClick={() => void onDownload(row.quote)}
                                title="Download PDF"
                                aria-label="Download PDF"
                              >
                                <Download className="h-4 w-4" />
                              </Button>

                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                onClick={() => void onView(row.quote)}
                                title="View"
                                aria-label="View"
                              >
                                <Eye className="h-4 w-4" />
                              </Button>

                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                onClick={() => onSend(row.quote)}
                                disabled={row.quote.status !== 'OPEN' || row.effectiveStatus === 'CLOSED'}
                                title="Send"
                                aria-label="Send"
                              >
                                <Send className="h-4 w-4" />
                              </Button>

                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                onClick={() => onAccept(row.quote)}
                                disabled={row.effectiveStatus === 'CLOSED'}
                                title={row.quote.status === 'ACCEPTED' ? 'Unaccept' : 'Accept'}
                                aria-label={row.quote.status === 'ACCEPTED' ? 'Unaccept' : 'Accept'}
                              >
                                <BadgeCheck className="h-4 w-4" />
                              </Button>

                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 w-9 p-0"
                                onClick={() => onDelete(row.quote)}
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
          type="QUOTE"
          doc={sendTarget}
          settings={settings}
          clientName={sendTarget.clientId ? (clientNameById[sendTarget.clientId] ?? undefined) : undefined}
          projectTitle={sendTarget.projectId ? (projectTitleById[sendTarget.projectId] ?? undefined) : undefined}
          onSent={() => {
            ;(async () => {
              try {
                const next = await fetchSalesQuote(sendTarget.id)
                setQuotes((prev) => prev.map((x) => (x.id === next.id ? next : x)))
                setSendTarget(next)
              } catch (e) {
                alert(e instanceof Error ? e.message : 'Failed to refresh quote')
              }
            })()
          }}
        />
      ) : null}
    </div>
  )
}
