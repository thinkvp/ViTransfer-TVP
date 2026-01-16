'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TypeaheadSelect } from '@/components/sales/TypeaheadSelect'
import {
  deleteQuote,
  getQuote,
  getSalesSettings,
  updateQuote,
} from '@/lib/sales/local-store'
import type { ClientOption, ProjectOption, QuoteStatus, SalesLineItem, SalesQuote } from '@/lib/sales/types'
import { fetchClientDetails, fetchClientOptions, fetchProjectOptions, fetchProjectOptionsForClient } from '@/lib/sales/lookups'
import {
  calcLineSubtotalCents,
  centsToDollars,
  dollarsToCents,
  sumLineItemsSubtotal,
  sumLineItemsTax,
} from '@/lib/sales/money'
import { downloadQuotePdf } from '@/lib/sales/pdf'
import { createSalesDocShareUrl } from '@/lib/sales/public-share'
import { SalesViewsAndTrackingSection } from '@/components/admin/sales/SalesViewsAndTrackingSection'
import { SalesSendEmailDialog } from '@/components/admin/sales/SalesSendEmailDialog'
import { apiFetch } from '@/lib/api-client'

const TAX_RATE_OPTIONS = [0, 10]

function normalizeTaxRatePercent(rate: unknown, defaultRate: number): number {
  const n = Number(rate)
  const candidate = Number.isFinite(n) ? n : defaultRate
  return candidate >= 5 ? 10 : 0
}

function newLineItem(defaultTaxRatePercent: number): SalesLineItem {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `li-${Date.now()}`,
    description: '',
    details: '',
    quantity: 1,
    unitPriceCents: 0,
    taxRatePercent: normalizeTaxRatePercent(defaultTaxRatePercent, defaultTaxRatePercent),
  }
}

const QUOTE_STATUSES: { value: QuoteStatus; label: string }[] = [
  { value: 'OPEN', label: 'Open' },
  { value: 'SENT', label: 'Sent' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'CLOSED', label: 'Closed' },
]

export default function QuoteDetailPage() {
  const params = useParams()
  const id = useMemo(() => {
    const raw = (params as any)?.id as string | string[] | undefined
    if (typeof raw === 'string') return raw
    if (Array.isArray(raw) && raw.length) return raw[0]
    return ''
  }, [params])

  const settings = useMemo(() => getSalesSettings(), [])

  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  const [quote, setQuote] = useState<SalesQuote | null>(null)
  const [shareToken, setShareToken] = useState<string | null | undefined>(undefined)
  const [trackingRefreshKey, setTrackingRefreshKey] = useState(0)
  const [sendOpen, setSendOpen] = useState(false)
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
  const [terms, setTerms] = useState(settings.defaultTerms)
  const [items, setItems] = useState<SalesLineItem[]>([])

  useEffect(() => {
    const q = id ? getQuote(id) : null
    setQuote(q)
    if (q) {
      setStatus(q.status)
      setClientId(q.clientId ?? '')
      setProjectId(q.projectId ?? '')
      setIssueDate(q.issueDate)
      setValidUntil(q.validUntil ?? '')
      setNotes(q.notes)
      setTerms(q.terms)
      setItems(
        q.items.map((it) => ({
          ...it,
          details: (it as any).details ?? '',
          taxRatePercent: normalizeTaxRatePercent((it as any).taxRatePercent, settings.taxRatePercent),
        }))
      )

      setEditingClient(!Boolean(q.clientId))
      setEditingProject(!Boolean(q.projectId))
    }
    setLoaded(true)
  }, [id, settings.taxRatePercent])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!id) return
      if (!cancelled) setShareToken(undefined)
      try {
        const res = await apiFetch(`/api/admin/sales/share-token?docType=QUOTE&docId=${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (!res.ok) return
        const json = (await res.json()) as { token: string | null }
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
  const totalCents = subtotalCents + taxCents

  const clientNameById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients])
  const projectTitleById = useMemo(
    () => Object.fromEntries([...projects, ...allProjects].map((p) => [p.id, p.title])),
    [allProjects, projects]
  )

  const onSave = async () => {
    if (!quote) return
    setSaving(true)
    try {
      const next = updateQuote(quote.id, {
        status,
        clientId: clientId || null,
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
      alert('Saved')
    } finally {
      setSaving(false)
    }
  }

  const onDelete = () => {
    if (!quote) return
    if (!confirm(`Delete quote ${quote.quoteNumber}?`)) return
    deleteQuote(quote.id)
    window.location.href = '/admin/sales/quotes'
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
        <div className="flex gap-2 flex-wrap">
          <Button
            type="button"
            variant="outline"
            title={((quote as any)?.remindersEnabled !== false) ? 'Sales reminders enabled' : 'Sales reminders disabled'}
            aria-label={((quote as any)?.remindersEnabled !== false) ? 'Sales reminders enabled' : 'Sales reminders disabled'}
            className={
              ((quote as any)?.remindersEnabled !== false)
                ? 'text-success hover:text-success hover:bg-success-visible'
                : 'text-destructive hover:text-destructive hover:bg-destructive-visible'
            }
            onClick={() => {
              const enabled = (quote as any)?.remindersEnabled !== false
              try {
                const next = updateQuote(quote.id, { remindersEnabled: !enabled } as any)
                setQuote(next)
              } catch {
                // ignore
              }
            }}
          >
            {((quote as any)?.remindersEnabled !== false) ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
          </Button>
          <Button variant="outline" onClick={() => void onViewPublic()}>
            View Quote
          </Button>
          <Button variant="outline" onClick={onSendEmail}>
            Send Email
          </Button>
          <Button
            variant="outline"
            onClick={() => void onDownloadPdf()}
          >
            Download PDF
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
              <Select value={status} onValueChange={(v) => setStatus(v as QuoteStatus)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {QUOTE_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <div key={it.id} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start rounded-md border border-border p-3">
                <div className="md:col-span-5 space-y-1">
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

                <div className="md:col-span-1 space-y-1">
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

                <div className="md:col-span-2 space-y-1">
                  <Label>Unit ($)</Label>
                  <Input
                    value={centsToDollars(it.unitPriceCents)}
                    onChange={(e) => {
                      const cents = dollarsToCents(e.target.value)
                      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, unitPriceCents: cents } : x)))
                    }}
                    className="h-9"
                  />
                </div>

                <div className="md:col-span-3 space-y-1">
                  <Label>Tax</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      value={String(it.taxRatePercent)}
                      onValueChange={(v) => {
                        const rate = Number(v)
                        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, taxRatePercent: normalizeTaxRatePercent(rate, settings.taxRatePercent) } : x)))
                      }}
                    >
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TAX_RATE_OPTIONS.map((r) => (
                          <SelectItem key={r} value={String(r)}>{r}%</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="h-9 rounded-md border border-border bg-muted px-3 flex items-center justify-end text-sm">
                      ${centsToDollars(calcLineSubtotalCents(it))}
                    </div>
                  </div>
                </div>

                <div className="md:col-span-1 flex justify-end">
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
            ))
          )}

          <div className="flex justify-between items-center gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setItems((prev) => [...prev, newLineItem(settings.taxRatePercent)])}>
              Add line
            </Button>
            <div className="text-sm">
              <div className="flex items-center justify-end gap-3">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="text-foreground font-medium tabular-nums">${centsToDollars(subtotalCents)}</span>
              </div>
              <div className="flex items-center justify-end gap-3">
                <span className="text-muted-foreground">Tax</span>
                <span className="text-foreground font-medium tabular-nums">${centsToDollars(taxCents)}</span>
              </div>
              <div className="flex items-center justify-end gap-3">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground font-semibold tabular-nums">${centsToDollars(totalCents)}</span>
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
          const updates: any = { sentAt: new Date().toISOString() }
          if (quote.status === 'OPEN') updates.status = 'SENT'
          const next = updateQuote(quote.id, updates)
          setQuote(next)
          setStatus(next.status)
          setShareToken(token)
          setTrackingRefreshKey((v) => v + 1)
        }}
      />

      <div className="flex justify-end">
        <Button variant="destructive" onClick={onDelete}>Delete quote</Button>
      </div>
    </div>
  )
}
