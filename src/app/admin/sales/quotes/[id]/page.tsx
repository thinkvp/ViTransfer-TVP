'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { Check, Download, Eye, Mail, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { TypeaheadSelect } from '@/components/sales/TypeaheadSelect'
import { TaxRateSelect } from '@/components/sales/TaxRateSelect'
import { deleteSalesQuote, fetchSalesQuote, fetchSalesSettings, fetchTaxRates, patchSalesQuote } from '@/lib/sales/admin-api'
import type { SalesQuoteWithVersion } from '@/lib/sales/admin-api'
import type { ClientOption, ProjectOption, QuoteStatus, SalesLineItem, SalesSettings, SalesTaxRate } from '@/lib/sales/types'
import { fetchClientDetails, fetchClientOptions, fetchProjectOptions, fetchProjectOptionsForClient } from '@/lib/sales/lookups'
import {
  calcLineSubtotalCents,
  centsToDollars,
  dollarsToCents,
  formatMoney,
  sumLineItemsSubtotal,
  sumLineItemsTax,
} from '@/lib/sales/money'
import { getCurrencySymbol } from '@/lib/sales/currency'
import { downloadQuotePdf } from '@/lib/sales/pdf'
import { createSalesDocShareUrl } from '@/lib/sales/public-share'
import { SalesViewsAndTrackingSection } from '@/components/admin/sales/SalesViewsAndTrackingSection'
import { SalesSendEmailDialog } from '@/components/admin/sales/SalesSendEmailDialog'
import { apiFetch } from '@/lib/api-client'
import { SalesRemindersBellButton } from '@/components/admin/sales/SalesRemindersBellButton'
import { quoteEffectiveStatus } from '@/lib/sales/status'

function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'SENT':
      return 'Sent'
    case 'OPENED':
      return 'Opened'
    case 'ACCEPTED':
      return 'Accepted'
    case 'CLOSED':
      return 'Closed'
  }
}

function normalizeTaxRatePercent(rate: unknown, defaultRate: number): number {
  const n = Number(rate)
  return Number.isFinite(n) && n >= 0 ? n : defaultRate
}

function newLineItem(defaultTaxRatePercent: number, defaultTaxRateName?: string): SalesLineItem {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `li-${Date.now()}`,
    description: '',
    details: '',
    quantity: 1,
    unitPriceCents: 0,
    taxRatePercent: normalizeTaxRatePercent(defaultTaxRatePercent, defaultTaxRatePercent),
    taxRateName: defaultTaxRateName,
  }
}

export default function QuoteDetailPage() {
  const params = useParams()
  const id = useMemo(() => {
    const raw = (params as any)?.id as string | string[] | undefined
    if (typeof raw === 'string') return raw
    if (Array.isArray(raw) && raw.length) return raw[0]
    return ''
  }, [params])

  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

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

  const [quote, setQuote] = useState<SalesQuoteWithVersion | null>(null)
  const [shareToken, setShareToken] = useState<string | null | undefined>(undefined)
  const [trackingRefreshKey, setTrackingRefreshKey] = useState(0)
  const [sendOpen, setSendOpen] = useState(false)
  const [quoteExpiryRemindersEnabled, setQuoteExpiryRemindersEnabled] = useState(false)
  const [clients, setClients] = useState<ClientOption[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [allProjects, setAllProjects] = useState<ProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)

  const [editingClient, setEditingClient] = useState(false)
  const [editingProject, setEditingProject] = useState(false)

  const [status, setStatus] = useState<QuoteStatus>('OPEN')
  const [clientId, setClientId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')
  const [items, setItems] = useState<SalesLineItem[]>([])
  const [taxRates, setTaxRates] = useState<SalesTaxRate[]>([])

  useEffect(() => {
    let cancelled = false
    setLoaded(false)

    ;(async () => {
      if (!id) {
        setQuote(null)
        setLoaded(true)
        return
      }

      try {
        const [s, q, rates] = await Promise.all([fetchSalesSettings(), fetchSalesQuote(id), fetchTaxRates()])
        if (cancelled) return

        setSettings(s)
        setTaxRates(rates)
        setQuote(q)
        setStatus(q.status)
        setClientId(q.clientId ?? '')
        setProjectId(q.projectId ?? '')
        setIssueDate(q.issueDate)
        setValidUntil(q.validUntil ?? '')
        setNotes(q.notes)
        setTerms(q.terms ?? s.defaultTerms)
        setItems(
          q.items.map((it) => ({
            ...it,
            details: (it as any).details ?? '',
            taxRatePercent: normalizeTaxRatePercent((it as any).taxRatePercent, s.taxRatePercent),
          }))
        )

        setEditingClient(!Boolean(q.clientId))
        setEditingProject(!Boolean(q.projectId))
      } catch {
        if (!cancelled) setQuote(null)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    let cancelled = false

    const loadReminders = async () => {
      try {
        const res = await apiFetch('/api/admin/sales/reminder-settings', { method: 'GET' })
        const json = await res.json().catch(() => null)
        if (!res.ok) return
        if (cancelled) return
        setQuoteExpiryRemindersEnabled(Boolean((json as any)?.quoteExpiryRemindersEnabled))
      } catch {
        // ignore
      }
    }

    void loadReminders()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!id) return
      if (!cancelled) setShareToken(undefined)
      try {
        const res = await apiFetch(`/api/admin/sales/share-token?docType=QUOTE&docId=${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (!res.ok) return
        const json = (await res.json()) as { token?: string | null }
        if (!cancelled) setShareToken(typeof json?.token === 'string' ? json.token : null)
      } catch {
        // ignore
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    const run = async () => {
      const c = await fetchClientOptions()
      setClients(c)
    }
    void run()
  }, [])

  useEffect(() => {
    const run = async () => {
      const p = await fetchProjectOptions().catch(() => [])
      setAllProjects(p)
    }
    void run()
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!clientId) return
      if (clients.some((c) => c.id === clientId)) return
      try {
        const details = await fetchClientDetails(clientId)
        if (!details?.id || !details?.name) return
        if (cancelled) return
        setClients((prev) => (prev.some((c) => c.id === details.id) ? prev : [{ id: details.id, name: details.name }, ...prev]))
      } catch {
        // ignore
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [clientId, clients])

  useEffect(() => {
    const run = async () => {
      if (!clientId) {
        setProjects([])
        return
      }

      setLoadingProjects(true)
      try {
        const p = await fetchProjectOptionsForClient(clientId)
        setProjects(p)
        const current = projectId
        const includeCurrent = current && !p.some((x) => x.id === current)
          ? allProjects.find((x) => x.id === current)
          : null
        setProjects(includeCurrent ? [...p, includeCurrent] : p)
      } finally {
        setLoadingProjects(false)
      }
    }
    void run()
  }, [allProjects, clientId, projectId])

  const subtotalCents = useMemo(() => sumLineItemsSubtotal(items), [items])
  const taxCents = useMemo(() => sumLineItemsTax(items, settings.taxRatePercent), [items, settings.taxRatePercent])
  const docTaxEnabled = quote?.taxEnabled ?? settings.taxEnabled
  const totalCents = subtotalCents + (docTaxEnabled ? taxCents : 0)

  const effectiveStatus = useMemo(
    () => quoteEffectiveStatus({ status, validUntil: validUntil || null }),
    [status, validUntil]
  )

  const clientNameById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients])
  const projectTitleById = useMemo(
    () => Object.fromEntries([...projects, ...allProjects].map((p) => [p.id, p.title])),
    [allProjects, projects]
  )

  const onSave = async () => {
    if (!quote) return
    if (!clientId) {
      alert('Select a client.')
      return
    }
    setSaving(true)
    try {
      const next = await patchSalesQuote(quote.id, {
        version: quote.version,
        status,
        acceptedFromStatus: quote.acceptedFromStatus ?? null,
        clientId,
        projectId: projectId || null,
        issueDate,
        validUntil: validUntil || null,
        notes,
        terms,
        items: items.map((it) => ({
          ...it,
          description: it.description ?? '',
          details: it.details?.trim() ? it.details : undefined,
          quantity: Number.isFinite(it.quantity) && it.quantity > 0 ? it.quantity : 1,
          unitPriceCents: Number.isFinite(it.unitPriceCents) ? it.unitPriceCents : 0,
          taxRatePercent: normalizeTaxRatePercent(it.taxRatePercent, settings.taxRatePercent),
        })),
      })
      setQuote(next)
      setStatus(next.status)
      alert('Saved')
    } finally {
      setSaving(false)
    }
  }

  const onDelete = () => {
    if (!quote) return
    if (!confirm(`Delete quote ${quote.quoteNumber}?`)) return
    ;(async () => {
      try {
        await deleteSalesQuote(quote.id)
        window.location.href = '/admin/sales/quotes'
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to delete quote'
        alert(msg)
      }
    })()
  }

  const onViewPublic = async () => {
    if (!quote) return
    const url = await createSalesDocShareUrl({
      type: 'QUOTE',
      doc: quote,
      settings,
      clientName: clientId ? clientNameById[clientId] : undefined,
      projectTitle: projectId ? projectTitleById[projectId] : undefined,
    })
    try {
      const token = new URL(url).pathname.split('/').filter(Boolean).at(-1)
      if (token) setShareToken(token)
    } catch {
      // ignore
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const onSendEmail = () => {
    if (!quote) return
    setSendOpen(true)
  }

  if (!loaded) {
    return <div className="flex items-center justify-center py-10 text-muted-foreground">Loading…</div>
  }

  if (!quote) {
    return (
      <div className="space-y-4">
        <div className="text-muted-foreground">Quote not found.</div>
        <Link href="/admin/sales/quotes"><Button variant="outline">Back to quotes</Button></Link>
      </div>
    )
  }

  const onDownloadPdf = async () => {
    const clientDetails = clientId ? await fetchClientDetails(clientId).catch(() => null) : null

    const publicQuoteUrl = await createSalesDocShareUrl({
      type: 'QUOTE',
      doc: quote,
      settings,
      clientName: clientId ? clientNameById[clientId] : undefined,
      projectTitle: projectId ? projectTitleById[projectId] : undefined,
    })

    await downloadQuotePdf(quote, settings, {
      clientName: clientId ? clientNameById[clientId] : undefined,
      clientAddress: clientDetails?.address ?? undefined,
      projectTitle: projectId ? projectTitleById[projectId] : undefined,
      publicQuoteUrl,
    })
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">{quote.quoteNumber}</h2>
          <p className="text-sm text-muted-foreground">View and edit quote details.</p>
        </div>
        <div className="flex gap-2 flex-wrap w-full justify-end sm:w-auto">
          {quoteExpiryRemindersEnabled ? (
            <SalesRemindersBellButton
              enabled={(quote as any)?.remindersEnabled !== false}
              onToggle={() => {
                const enabled = (quote as any)?.remindersEnabled !== false
                ;(async () => {
                  try {
                    const next = await patchSalesQuote(quote.id, {
                      version: quote.version,
                      remindersEnabled: !enabled,
                    })
                    setQuote(next)
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : 'Failed to update quote'
                    if (msg === 'Conflict') {
                      alert('This quote was updated in another session. Reloading.')
                      window.location.reload()
                      return
                    }
                    alert(msg)
                  }
                })()
              }}
            />
          ) : null}
          <Button
            variant="outline"
            onClick={() => void onViewPublic()}
            aria-label="View Quote"
            title="View Quote"
            className="w-10 px-0 sm:w-auto sm:px-4"
          >
            <Eye className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">View Quote</span>
          </Button>
          <Button
            variant="outline"
            onClick={onSendEmail}
            aria-label="Send Email"
            title="Send Email"
            className="w-10 px-0 sm:w-auto sm:px-4"
          >
            <Mail className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Send Email</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => void onDownloadPdf()}
            aria-label="Download PDF"
            title="Download PDF"
            className="w-10 px-0 sm:w-auto sm:px-4"
          >
            <Download className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Download PDF</span>
          </Button>
          <Button
            variant="destructive"
            onClick={onDelete}
            aria-label="Delete quote"
            title="Delete quote"
            className="w-10 px-0 sm:w-auto sm:px-4"
          >
            <Trash2 className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Delete</span>
          </Button>
          <Button onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Client</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  title={editingClient ? 'Stop editing' : 'Edit client'}
                  onClick={() => setEditingClient((v) => !v)}
                >
                  {editingClient ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                </Button>
              </div>

              {editingClient ? (
                <TypeaheadSelect
                  value={clientId}
                  onValueChange={(v) => {
                    setClientId(v)
                    setProjectId('')
                    setEditingClient(false)
                    setEditingProject(true)
                  }}
                  options={clients.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="Search client"
                  allowNone
                />
              ) : clientId ? (
                <Link
                  href={`/admin/clients/${encodeURIComponent(clientId)}`}
                  className="h-9 rounded-md border border-border bg-muted px-3 flex items-center hover:underline"
                  title="Open client"
                >
                  <span className="text-sm">{clientNameById[clientId] ?? clientId}</span>
                </Link>
              ) : (
                <div className="h-9 rounded-md border border-border bg-muted px-3 flex items-center text-sm text-muted-foreground">
                  None
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Project</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  title={editingProject ? 'Stop editing' : 'Edit project'}
                  onClick={() => setEditingProject((v) => !v)}
                  disabled={!clientId}
                >
                  {editingProject ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                </Button>
              </div>

              {editingProject ? (
                <TypeaheadSelect
                  value={projectId}
                  onValueChange={(v) => {
                    setProjectId(v)
                    setEditingProject(false)
                  }}
                  options={projects.map((p) => ({ value: p.id, label: p.title }))}
                  placeholder={!clientId ? 'Select a client first' : loadingProjects ? 'Loading…' : 'Search project'}
                  disabled={!clientId}
                  allowNone
                />
              ) : projectId ? (
                <Link
                  href={`/admin/projects/${encodeURIComponent(projectId)}`}
                  className="h-9 rounded-md border border-border bg-muted px-3 flex items-center hover:underline"
                  title="Open project"
                >
                  <span className="text-sm">{projectTitleById[projectId] ?? projectId}</span>
                </Link>
              ) : (
                <div className="h-9 rounded-md border border-border bg-muted px-3 flex items-center text-sm text-muted-foreground">
                  {!clientId ? 'Select a client first' : 'None'}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Issue date</Label>
              <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="h-9" />
            </div>

            <div className="space-y-2">
              <Label>Valid until</Label>
              <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="h-9" />
            </div>

            <div className="space-y-2">
              <Label>Status</Label>
              <Input value={quoteStatusLabel(effectiveStatus)} readOnly className="h-9" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          {items.length === 0 ? (
            <div className="text-sm text-muted-foreground">No items yet.</div>
          ) : (
            items.map((it) => (
              <div key={it.id} className="grid grid-cols-1 md:grid-cols-[minmax(0,5fr)_minmax(0,3fr)_minmax(0,4fr)] gap-2 items-start rounded-md border border-border p-3">
                <div className="space-y-1">
                  <Label>Item</Label>
                  <Input
                    value={it.description}
                    onChange={(e) => {
                      const v = e.target.value
                      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, description: v } : x)))
                    }}
                    className="h-9"
                  />

                  <div className="pt-2 space-y-1">
                    <Label>Description (optional)</Label>
                    <Textarea
                      value={it.details ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, details: v } : x)))
                      }}
                      placeholder="Optional paragraph description…"
                      className="min-h-[90px]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  <div className="space-y-1 md:col-span-1">
                    <Label>Qty</Label>
                    <Input
                      type="number"
                      value={String(it.quantity)}
                      min={1}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, quantity: Number.isFinite(v) && v > 0 ? v : 1 } : x)))
                      }}
                      className="h-9"
                    />
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <Label>{`Unit (${getCurrencySymbol(settings.currencyCode)})`}</Label>
                    <Input
                      value={centsToDollars(it.unitPriceCents)}
                      onChange={(e) => {
                        const cents = dollarsToCents(e.target.value)
                        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, unitPriceCents: cents } : x)))
                      }}
                      className="h-9"
                    />
                  </div>
                </div>

                {docTaxEnabled && (
                <div className="space-y-1">
                  <Label>Tax</Label>
                  <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                    <div className="grid grid-cols-2 gap-2">
                      <TaxRateSelect
                        value={it.taxRatePercent}
                        onChange={(rate, name) => setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, taxRatePercent: normalizeTaxRatePercent(rate, settings.taxRatePercent), taxRateName: name } : x)))}
                        taxRates={taxRates}
                        className="h-9"
                      />
                      <div className="h-9 rounded-md border border-border bg-muted px-3 flex items-center justify-end text-sm">
                        {formatMoney(calcLineSubtotalCents(it), getCurrencySymbol(settings.currencyCode))}
                      </div>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 w-9 p-0"
                      aria-label="Remove line"
                      title="Remove"
                      onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}
                      disabled={items.length <= 1}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                )}

                {!docTaxEnabled && (
                <div className="space-y-1">
                  <Label>Amount</Label>
                  <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                    <div className="h-9 rounded-md border border-border bg-muted px-3 flex items-center justify-end text-sm">
                      {formatMoney(calcLineSubtotalCents(it), getCurrencySymbol(settings.currencyCode))}
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 w-9 p-0"
                      aria-label="Remove line"
                      title="Remove"
                      onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}
                      disabled={items.length <= 1}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                )}
              </div>
            ))
          )}

          <div className="flex justify-between items-center gap-2 flex-wrap">
            <Button variant="outline" onClick={() => { const pr = taxRates.find((r) => r.isDefault); setItems((prev) => [...prev, newLineItem(settings.taxRatePercent, pr?.name)]) }}>
              Add line
            </Button>
            <div className="text-sm">
              <div className="flex items-center justify-end gap-3">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="text-foreground font-medium tabular-nums">{formatMoney(subtotalCents, getCurrencySymbol(settings.currencyCode))}</span>
              </div>
              {docTaxEnabled && (
              <div className="flex items-center justify-end gap-3">
                <span className="text-muted-foreground">Tax</span>
                <span className="text-foreground font-medium tabular-nums">{formatMoney(taxCents, getCurrencySymbol(settings.currencyCode))}</span>
              </div>
              )}
              <div className="flex items-center justify-end gap-3">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground font-semibold tabular-nums">{formatMoney(totalCents, getCurrencySymbol(settings.currencyCode))}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-6">
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes…" />
          </div>
          <div className="space-y-2">
            <Label>Terms & conditions</Label>
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <SalesViewsAndTrackingSection shareToken={shareToken} refreshKey={trackingRefreshKey} />

      <SalesSendEmailDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        type="QUOTE"
        doc={quote}
        settings={settings}
        clientName={clientId ? clientNameById[clientId] : undefined}
        projectTitle={projectId ? projectTitleById[projectId] : undefined}
        onSent={({ shareToken: token }) => {
          ;(async () => {
            try {
              const next = await fetchSalesQuote(quote.id)
              setQuote(next)
              setStatus(next.status)
              setShareToken(token)
              setTrackingRefreshKey((v) => v + 1)
            } catch (e) {
              alert(e instanceof Error ? e.message : 'Failed to refresh quote')
            }
          })()
        }}
      />

    </div>
  )
}
