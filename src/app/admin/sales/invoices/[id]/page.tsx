'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TypeaheadSelect } from '@/components/sales/TypeaheadSelect'
import {
  deleteInvoice,
  getInvoice,
  getSalesSettings,
  listPayments,
  updateInvoice,
} from '@/lib/sales/local-store'
import type { ClientOption, InvoiceStatus, ProjectOption, SalesInvoice, SalesLineItem } from '@/lib/sales/types'
import { fetchClientDetails, fetchClientOptions, fetchProjectOptionsForClient } from '@/lib/sales/lookups'
import {
  calcLineSubtotalCents,
  centsToDollars,
  dollarsToCents,
  sumLineItemsSubtotal,
  sumLineItemsTax,
} from '@/lib/sales/money'
import { downloadInvoicePdf } from '@/lib/sales/pdf'
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

const INVOICE_STATUSES: { value: InvoiceStatus; label: string }[] = [
  { value: 'OPEN', label: 'Open' },
  { value: 'SENT', label: 'Sent' },
  { value: 'OVERDUE', label: 'Overdue' },
  { value: 'PAID', label: 'Paid' },
]

export default function InvoiceDetailPage() {
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

  const [invoice, setInvoice] = useState<SalesInvoice | null>(null)
  const [shareToken, setShareToken] = useState<string | null | undefined>(undefined)
  const [trackingRefreshKey, setTrackingRefreshKey] = useState(0)
  const [sendOpen, setSendOpen] = useState(false)
  const [clients, setClients] = useState<ClientOption[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)

  const [status, setStatus] = useState<InvoiceStatus>('OPEN')
  const [clientId, setClientId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState(settings.defaultTerms)
  const [items, setItems] = useState<SalesLineItem[]>([])

  useEffect(() => {
    const inv = id ? getInvoice(id) : null
    setInvoice(inv)
    if (inv) {
      setStatus(inv.status)
      setClientId(inv.clientId ?? '')
      setProjectId(inv.projectId ?? '')
      setIssueDate(inv.issueDate)
      setDueDate(inv.dueDate ?? '')
      setNotes(inv.notes)
      setTerms(inv.terms)
      setItems(
        inv.items.map((it) => ({
          ...it,
          details: (it as any).details ?? '',
          taxRatePercent: normalizeTaxRatePercent((it as any).taxRatePercent, settings.taxRatePercent),
        }))
      )
    }
    setLoaded(true)
  }, [id, settings.taxRatePercent])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!id) return
      if (!cancelled) setShareToken(undefined)
      try {
        const res = await apiFetch(`/api/admin/sales/share-token?docType=INVOICE&docId=${encodeURIComponent(id)}`, { cache: 'no-store' })
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

  const onSendEmail = () => {
    if (!invoice) return
    setSendOpen(true)
  }

  useEffect(() => {
    const run = async () => {
      const c = await fetchClientOptions()
      setClients(c)
    }
    void run()
  }, [])

  useEffect(() => {
    const run = async () => {
      if (!clientId) {
        setProjects([])
        setProjectId('')
        return
      }

      setLoadingProjects(true)
      try {
        const p = await fetchProjectOptionsForClient(clientId)
        setProjects(p)
        setProjectId((prev) => (p.some((x) => x.id === prev) ? prev : ''))
      } finally {
        setLoadingProjects(false)
      }
    }
    void run()
  }, [clientId])

  const subtotalCents = useMemo(() => sumLineItemsSubtotal(items), [items])
  const taxCents = useMemo(() => sumLineItemsTax(items, settings.taxRatePercent), [items, settings.taxRatePercent])
  const totalCents = subtotalCents + taxCents

  const payments = useMemo(() => listPayments().filter((p) => p.invoiceId === id), [id])
  const paidCents = useMemo(() => payments.reduce((acc, p) => acc + p.amountCents, 0), [payments])
  const balanceCents = Math.max(0, totalCents - paidCents)

  const clientNameById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients])
  const projectTitleById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.title])), [projects])

  const onSave = async () => {
    if (!invoice) return
    setSaving(true)
    try {
      const next = updateInvoice(invoice.id, {
        status,
        clientId: clientId || null,
        projectId: projectId || null,
        issueDate,
        dueDate: dueDate || null,
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
      setInvoice(next)
      alert('Saved')
    } finally {
      setSaving(false)
    }
  }

  const onDelete = () => {
    if (!invoice) return
    if (!confirm(`Delete invoice ${invoice.invoiceNumber}?`)) return
    deleteInvoice(invoice.id)
    window.location.href = '/admin/sales/invoices'
  }

  const onViewPublic = async () => {
    if (!invoice) return

    const latestPaymentDate = payments
      .map((p) => p.paymentDate)
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      .sort()
      .at(-1)

    const invoicePaidAt = (status === 'PAID' || (totalCents > 0 && balanceCents <= 0))
      ? (latestPaymentDate ?? new Date().toISOString().slice(0, 10))
      : null

    const url = await createSalesDocShareUrl({
      type: 'INVOICE',
      doc: invoice,
      settings,
      clientName: clientId ? clientNameById[clientId] : undefined,
      projectTitle: projectId ? projectTitleById[projectId] : undefined,
      invoicePaidAt,
    })
    try {
      const token = new URL(url).pathname.split('/').filter(Boolean).at(-1)
      if (token) setShareToken(token)
    } catch {
      // ignore
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  if (!loaded) {
    return <div className="flex items-center justify-center py-10 text-muted-foreground">Loading…</div>
  }

  if (!invoice) {
    return (
      <div className="space-y-4">
        <div className="text-muted-foreground">Invoice not found.</div>
        <Link href="/admin/sales/invoices"><Button variant="outline">Back to invoices</Button></Link>
      </div>
    )
  }

  const onDownloadPdf = async () => {
    const clientDetails = clientId ? await fetchClientDetails(clientId).catch(() => null) : null
    await downloadInvoicePdf(invoice, settings, {
      clientName: clientId ? clientNameById[clientId] : undefined,
      clientAddress: clientDetails?.address ?? undefined,
      projectTitle: projectId ? projectTitleById[projectId] : undefined,
    })
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">{invoice.invoiceNumber}</h2>
          <p className="text-sm text-muted-foreground">View and edit invoice details.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/admin/sales/invoices"><Button variant="outline">Back</Button></Link>
          <Button variant="outline" onClick={() => void onViewPublic()}>
            View Invoice
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
              <Label>Client</Label>
              <TypeaheadSelect
                value={clientId}
                onValueChange={(v) => {
                  setClientId(v)
                  setProjectId('')
                }}
                options={clients.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="Search client"
                allowNone
              />
            </div>

            <div className="space-y-2">
              <Label>Project</Label>
              <TypeaheadSelect
                value={projectId}
                onValueChange={setProjectId}
                options={projects.map((p) => ({ value: p.id, label: p.title }))}
                placeholder={!clientId ? 'Select a client first' : loadingProjects ? 'Loading…' : 'Search project'}
                disabled={!clientId}
                allowNone
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Issue date</Label>
              <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="h-9" />
            </div>

            <div className="space-y-2">
              <Label>Due date</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="h-9" />
            </div>

            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as InvoiceStatus)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INVOICE_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Payments</Label>
            <div className="h-9 rounded-md border border-border bg-muted px-3 flex items-center justify-between text-sm">
              <span>Paid: ${centsToDollars(paidCents)}</span>
              <span>Balance: ${centsToDollars(balanceCents)}</span>
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
        type="INVOICE"
        doc={invoice}
        settings={settings}
        clientName={clientId ? clientNameById[clientId] : undefined}
        projectTitle={projectId ? projectTitleById[projectId] : undefined}
        onSent={({ shareToken: token }) => {
          const updates: any = { sentAt: new Date().toISOString() }
          if (invoice.status === 'OPEN') updates.status = 'SENT'
          const next = updateInvoice(invoice.id, updates)
          setInvoice(next)
          setStatus(next.status)
          setShareToken(token)
          setTrackingRefreshKey((v) => v + 1)
        }}
      />

      <div className="flex justify-end">
        <Button variant="destructive" onClick={onDelete}>Delete invoice</Button>
      </div>
    </div>
  )
}
