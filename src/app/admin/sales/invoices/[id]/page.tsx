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
  deleteSalesInvoice,
  fetchSalesInvoice,
  fetchSalesSettings,
  listSalesPayments,
  patchSalesInvoice,
} from '@/lib/sales/admin-api'
import type { SalesInvoiceWithVersion } from '@/lib/sales/admin-api'
import type { ClientOption, InvoiceStatus, ProjectOption, SalesLineItem, SalesPayment, SalesSettings } from '@/lib/sales/types'
import { fetchClientDetails, fetchClientOptions, fetchProjectOptions, fetchProjectOptionsForClient } from '@/lib/sales/lookups'
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

function parseDateOnlyLocal(value: string | null | undefined): Date | null {
  if (!value) return null
  const s = String(value).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    const yyyy = Number(m[1])
    const mm = Number(m[2])
    const dd = Number(m[3])
    if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null
    return new Date(yyyy, mm - 1, dd)
  }
  const d = new Date(s)
  return Number.isFinite(d.getTime()) ? d : null
}

function endOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
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
  { value: 'PARTIALLY_PAID', label: 'Partially Paid (auto)' },
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

  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [nowIso, setNowIso] = useState<string | null>(null)

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

  const [invoice, setInvoice] = useState<SalesInvoiceWithVersion | null>(null)
  const [shareToken, setShareToken] = useState<string | null | undefined>(undefined)
  const [trackingRefreshKey, setTrackingRefreshKey] = useState(0)
  const [sendOpen, setSendOpen] = useState(false)
  const [clients, setClients] = useState<ClientOption[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [allProjects, setAllProjects] = useState<ProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)

  const [editingClient, setEditingClient] = useState(false)
  const [editingProject, setEditingProject] = useState(false)
  const [stripePayments, setStripePayments] = useState<Array<{
    id: string
    invoiceDocId: string
    invoiceNumber: string
    currency: string
    invoiceAmountCents: number
    feeAmountCents: number
    totalAmountCents: number
    stripeCheckoutSessionId: string
    stripePaymentIntentId: string | null
    stripeChargeId: string | null
    createdAt: string
  }>>([])

  const [status, setStatus] = useState<InvoiceStatus>('OPEN')
  const [clientId, setClientId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')
  const [items, setItems] = useState<SalesLineItem[]>([])
  const [payments, setPayments] = useState<SalesPayment[]>([])

  useEffect(() => {
    let cancelled = false
    setLoaded(false)

    ;(async () => {
      if (!id) {
        setInvoice(null)
        setPayments([])
        setLoaded(true)
        return
      }

      try {
        const [s, inv, pay] = await Promise.all([
          fetchSalesSettings(),
          fetchSalesInvoice(id),
          listSalesPayments({ invoiceId: id, limit: 5000 }),
        ])

        if (cancelled) return

        setSettings(s)
        setInvoice(inv)
        setPayments(pay)

        setStatus(inv.status)
        setClientId(inv.clientId ?? '')
        setProjectId(inv.projectId ?? '')
        setIssueDate(inv.issueDate)
        setDueDate(inv.dueDate ?? '')
        setNotes(inv.notes)
        setTerms(inv.terms ?? s.defaultTerms)
        setItems(
          inv.items.map((it) => ({
            ...it,
            details: (it as any).details ?? '',
            taxRatePercent: normalizeTaxRatePercent((it as any).taxRatePercent, s.taxRatePercent),
          }))
        )

        setEditingClient(!Boolean(inv.clientId))
        setEditingProject(!Boolean(inv.projectId))
      } catch {
        if (!cancelled) {
          setInvoice(null)
          setPayments([])
        }
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    setNowIso(new Date().toISOString())
    const onFocus = () => setNowIso(new Date().toISOString())
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

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

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!id) {
        if (!cancelled) setStripePayments([])
        return
      }

      try {
        const res = await apiFetch(`/api/admin/sales/stripe-payments?invoiceDocId=${encodeURIComponent(id)}&limit=200`, { cache: 'no-store' })
        if (!res.ok) return
        const json = (await res.json().catch(() => null)) as { payments?: unknown[] } | null
        const list = Array.isArray(json?.payments) ? json!.payments! : []

        const parsed = list
          .map((p: any) => ({
            id: typeof p?.id === 'string' ? p.id : '',
            invoiceDocId: typeof p?.invoiceDocId === 'string' ? p.invoiceDocId : '',
            invoiceNumber: typeof p?.invoiceNumber === 'string' ? p.invoiceNumber : '',
            currency: typeof p?.currency === 'string' ? p.currency : '',
            invoiceAmountCents: Number(p?.invoiceAmountCents),
            feeAmountCents: Number(p?.feeAmountCents),
            totalAmountCents: Number(p?.totalAmountCents),
            stripeCheckoutSessionId: typeof p?.stripeCheckoutSessionId === 'string' ? p.stripeCheckoutSessionId : '',
            stripePaymentIntentId: typeof p?.stripePaymentIntentId === 'string' ? p.stripePaymentIntentId : null,
            stripeChargeId: typeof p?.stripeChargeId === 'string' ? p.stripeChargeId : null,
            createdAt: typeof p?.createdAt === 'string' ? p.createdAt : '',
          }))
          .filter((p) => p.id && p.invoiceDocId && Number.isFinite(p.invoiceAmountCents))

        if (!cancelled) setStripePayments(parsed)
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
      const p = await fetchProjectOptions().catch(() => [])
      setAllProjects(p)
    }
    void run()
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!clientId) return
      // Ensure current client label is available even if options haven't loaded yet.
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

  const localPaidCents = useMemo(() => payments.reduce((acc, p) => acc + p.amountCents, 0), [payments])
  const stripePaidCents = useMemo(() => stripePayments.reduce((acc, p) => acc + (Number.isFinite(p.invoiceAmountCents) ? p.invoiceAmountCents : 0), 0), [stripePayments])
  const paidCents = localPaidCents + stripePaidCents
  const balanceCents = Math.max(0, totalCents - paidCents)

  const paidOnYmd = useMemo((): string | null => {
    if (paidCents <= 0) return null

    const latestLocalYmd = payments
      .map((p) => p.paymentDate)
      .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .at(-1)
      ?? null

    const latestStripeYmd = stripePayments
      .map((p) => (typeof p.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.createdAt) ? p.createdAt.slice(0, 10) : null))
      .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .at(-1)
      ?? null

    return [latestLocalYmd, latestStripeYmd]
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      .sort()
      .at(-1)
      ?? null
  }, [paidCents, payments, stripePayments])

  const paidOnDisplay = useMemo((): string | null => {
    if (!paidOnYmd) return null
    return paidOnYmd.replaceAll('-', '/')
  }, [paidOnYmd])

  const effectiveStatus = useMemo((): InvoiceStatus => {
    const baseStatus: InvoiceStatus = status === 'OPEN' || status === 'SENT'
      ? status
      : (invoice?.sentAt ? 'SENT' : 'OPEN')

    if (totalCents <= 0) return baseStatus
    if (balanceCents <= 0) return 'PAID'

    const due = parseDateOnlyLocal(dueDate || invoice?.dueDate)
    const nowMs = nowIso ? new Date(nowIso).getTime() : 0
    const isPastDue = Boolean(due) && nowMs > endOfDayLocal(due as Date).getTime()
    if (isPastDue) return 'OVERDUE'
    if (paidCents > 0) return 'PARTIALLY_PAID'

    return baseStatus
  }, [balanceCents, dueDate, invoice?.dueDate, invoice?.sentAt, nowIso, paidCents, status, totalCents])

  const clientNameById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients])
  const projectTitleById = useMemo(
    () => Object.fromEntries([...projects, ...allProjects].map((p) => [p.id, p.title])),
    [allProjects, projects]
  )

  const onSave = async () => {
    if (!invoice) return
    if (!clientId) {
      alert('Select a client.')
      return
    }
    setSaving(true)
    try {
      const next = await patchSalesInvoice(invoice.id, {
        version: invoice.version,
        status,
        clientId,
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
      setStatus(next.status)
      alert('Saved')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save invoice'
      if (msg === 'Conflict') {
        alert('This invoice was updated in another session. Reloading.')
        window.location.reload()
        return
      }
      alert(msg)
    } finally {
      setSaving(false)
    }
  }

  const onDelete = () => {
    if (!invoice) return
    if (!confirm(`Delete invoice ${invoice.invoiceNumber}?`)) return
    ;(async () => {
      try {
        await deleteSalesInvoice(invoice.id)
        window.location.href = '/admin/sales/invoices'
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to delete invoice'
        alert(msg)
      }
    })()
  }

  const onViewPublic = async () => {
    if (!invoice) return

    const latestPaymentDate = payments
      .map((p) => p.paymentDate)
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      .sort()
      .at(-1)

    const latestStripeYmd = stripePayments
      .map((p) => (typeof p.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.createdAt) ? p.createdAt.slice(0, 10) : ''))
      .filter((d) => Boolean(d))
      .sort()
      .at(-1)

    const latestAnyPaymentYmd = [latestPaymentDate, latestStripeYmd]
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      .sort()
      .at(-1)
      ?? null

    const invoicePaidAt = (effectiveStatus === 'PAID' || (totalCents > 0 && balanceCents <= 0))
      ? (latestAnyPaymentYmd ?? new Date().toISOString().slice(0, 10))
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
    let publicInvoiceUrl: string | undefined
    try {
      const latestPaymentDate = payments
        .map((p) => p.paymentDate)
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .sort()
        .at(-1)

      const latestStripeYmd = stripePayments
        .map((p) => (typeof p.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.createdAt) ? p.createdAt.slice(0, 10) : ''))
        .filter((d) => Boolean(d))
        .sort()
        .at(-1)

      const latestAnyPaymentYmd = [latestPaymentDate, latestStripeYmd]
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .sort()
        .at(-1)
        ?? null

      const invoicePaidAt = (effectiveStatus === 'PAID' || (totalCents > 0 && balanceCents <= 0))
        ? (latestAnyPaymentYmd ?? new Date().toISOString().slice(0, 10))
        : null

      publicInvoiceUrl = await createSalesDocShareUrl({
        type: 'INVOICE',
        doc: invoice,
        settings,
        clientName: clientId ? clientNameById[clientId] : undefined,
        projectTitle: projectId ? projectTitleById[projectId] : undefined,
        invoicePaidAt,
      })
    } catch {
      // ignore; PDF should still download with payment details
    }
    await downloadInvoicePdf(invoice, settings, {
      clientName: clientId ? clientNameById[clientId] : undefined,
      clientAddress: clientDetails?.address ?? undefined,
      projectTitle: projectId ? projectTitleById[projectId] : undefined,
      publicInvoiceUrl,
    })
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-semibold">{invoice.invoiceNumber}</h2>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(effectiveStatus)}`}>
              {statusLabel(effectiveStatus)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">View and edit invoice details.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            type="button"
            variant="outline"
            title={((invoice as any)?.remindersEnabled !== false) ? 'Sales reminders enabled' : 'Sales reminders disabled'}
            aria-label={((invoice as any)?.remindersEnabled !== false) ? 'Sales reminders enabled' : 'Sales reminders disabled'}
            className={
              ((invoice as any)?.remindersEnabled !== false)
                ? 'text-success hover:text-success hover:bg-success-visible'
                : 'text-destructive hover:text-destructive hover:bg-destructive-visible'
            }
            onClick={() => {
              const enabled = (invoice as any)?.remindersEnabled !== false
              ;(async () => {
                try {
                  const next = await patchSalesInvoice(invoice.id, {
                    version: invoice.version,
                    remindersEnabled: !enabled,
                  })
                  setInvoice(next)
                } catch (e) {
                  const msg = e instanceof Error ? e.message : 'Failed to update invoice'
                  if (msg === 'Conflict') {
                    alert('This invoice was updated in another session. Reloading.')
                    window.location.reload()
                    return
                  }
                  alert(msg)
                }
              })()
            }}
          >
            {((invoice as any)?.remindersEnabled !== false) ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
          </Button>
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
              <Label>Due date</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="h-9" />
            </div>

            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as InvoiceStatus)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INVOICE_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value} disabled={s.value === 'PARTIALLY_PAID'}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {effectiveStatus !== status ? (
                <div className="text-xs text-muted-foreground">
                  Effective status is {statusLabel(effectiveStatus)} (based on payments / due date).
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Payments</Label>
            <div className="h-9 rounded-md border border-border bg-muted px-3 flex items-center justify-between text-sm">
              <span>
                Paid: ${centsToDollars(paidCents)}{paidOnDisplay ? <span> on {paidOnDisplay}</span> : null}
                {stripePaidCents > 0 ? <span className="text-muted-foreground"> (Stripe: ${centsToDollars(stripePaidCents)})</span> : null}
              </span>
              <span>Balance: ${centsToDollars(balanceCents)}</span>
            </div>

            {stripePayments.length > 0 && (
              <div className="rounded-md border border-border bg-background p-3 text-sm">
                <div className="font-medium mb-2">Stripe payments</div>
                <div className="space-y-1 text-muted-foreground">
                  {stripePayments.slice(0, 5).map((p) => (
                    <div key={p.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="min-w-[220px]">
                        {/^\d{4}-\d{2}-\d{2}/.test(p.createdAt) ? p.createdAt.slice(0, 10) : '—'}
                        {p.stripePaymentIntentId ? <span> · {p.stripePaymentIntentId}</span> : p.stripeCheckoutSessionId ? <span> · {p.stripeCheckoutSessionId}</span> : null}
                      </div>
                      <div className="tabular-nums">
                        Applied to invoice: ${centsToDollars(p.invoiceAmountCents)}
                        {p.feeAmountCents > 0 ? <span> (Fee: ${centsToDollars(p.feeAmountCents)})</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
          ;(async () => {
            try {
              const updates: any = { sentAt: new Date().toISOString() }
              if (invoice.status === 'OPEN') updates.status = 'SENT'
              const next = await patchSalesInvoice(invoice.id, {
                version: invoice.version,
                ...updates,
              })
              setInvoice(next)
              setStatus(next.status)
              setShareToken(token)
              setTrackingRefreshKey((v) => v + 1)
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Failed to update invoice'
              if (msg === 'Conflict') {
                alert('This invoice was updated in another session. Reloading.')
                window.location.reload()
                return
              }
              alert(msg)
            }
          })()
        }}
      />

      <div className="flex justify-end">
        <Button variant="destructive" onClick={onDelete}>Delete invoice</Button>
      </div>
    </div>
  )
}
