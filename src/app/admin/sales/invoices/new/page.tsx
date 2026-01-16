'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TypeaheadSelect } from '@/components/sales/TypeaheadSelect'
import { createSalesInvoice, fetchSalesSettings } from '@/lib/sales/admin-api'
import type { ClientOption, ProjectOption, SalesLineItem, SalesSettings } from '@/lib/sales/types'
import { fetchClientOptions, fetchProjectOptionsForClient } from '@/lib/sales/lookups'
import {
  calcLineSubtotalCents,
  centsToDollars,
  dollarsToCents,
  sumLineItemsSubtotal,
  sumLineItemsTax,
} from '@/lib/sales/money'

const TAX_RATE_OPTIONS = [0, 10]

function getTodayYmdLocal(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function normalizeTaxRatePercent(rate: unknown, defaultRate: number): number {
  const n = Number(rate)
  const candidate = Number.isFinite(n) ? n : defaultRate
  return candidate >= 5 ? 10 : 0
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00`)
  if (!Number.isFinite(d.getTime())) return ''
  d.setDate(d.getDate() + (Number.isFinite(days) ? days : 0))
  return d.toISOString().slice(0, 10)
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

export default function NewInvoicePage() {
  const [clients, setClients] = useState<ClientOption[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loadingClients, setLoadingClients] = useState(true)
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [creating, setCreating] = useState(false)

  const [clientId, setClientId] = useState<string>('')
  const [projectId, setProjectId] = useState<string>('')
  const [issueDate, setIssueDate] = useState<string>(() => getTodayYmdLocal())
  const [dueDate, setDueDate] = useState<string>('')

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

  const [notes, setNotes] = useState<string>('')
  const [terms, setTerms] = useState<string>('')
  const [items, setItems] = useState<SalesLineItem[]>(() => [newLineItem(10)])

  useEffect(() => {
    let cancelled = false
    setLoadingSettings(true)
    ;(async () => {
      try {
        const s = await fetchSalesSettings()
        if (cancelled) return
        setSettings(s)
        setTerms((prev) => (prev ? prev : s.defaultTerms))
        setItems((prev) => {
          if (!prev.length) return [newLineItem(s.taxRatePercent)]
          return prev
        })
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingSettings(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
    // Prefill due-date only when empty.
    setDueDate((prev) => {
      if (prev) return prev
      return addDaysYmd(issueDate, settings.defaultInvoiceDueDays ?? 7)
    })
  }, [issueDate, settings.defaultInvoiceDueDays])

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
        setProjectId('')
      } finally {
        setLoadingProjects(false)
      }
    }

    void run()
  }, [clientId])

  const subtotalCents = useMemo(() => sumLineItemsSubtotal(items), [items])
  const taxCents = useMemo(() => sumLineItemsTax(items, settings.taxRatePercent), [items, settings.taxRatePercent])
  const totalCents = subtotalCents + taxCents

  const onCreate = async () => {
    if (!clientId) {
      alert('Select a client.')
      return
    }

    if (items.every((it) => !it.description.trim())) {
      alert('Add at least one line item item name.')
      return
    }

    setCreating(true)
    try {
      const inv = await createSalesInvoice({
        clientId,
        projectId: projectId || null,
        issueDate,
        dueDate: dueDate || null,
        notes,
        terms,
        items: items.map((it) => ({
          ...it,
          details: it.details?.trim() ? it.details : undefined,
          quantity: Number.isFinite(it.quantity) && it.quantity > 0 ? it.quantity : 1,
          unitPriceCents: Number.isFinite(it.unitPriceCents) ? it.unitPriceCents : 0,
          taxRatePercent: normalizeTaxRatePercent(it.taxRatePercent, settings.taxRatePercent),
        })),
      })

      alert(`Created invoice ${inv.invoiceNumber}`)
      window.location.href = `/admin/sales/invoices/${inv.id}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create invoice'
      alert(msg)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Create invoice</h2>
          <p className="text-sm text-muted-foreground">Draft an invoice and link it to a client/project.</p>
        </div>
        <Link href="/admin/sales/invoices"><Button variant="outline">Back to invoices</Button></Link>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Client</Label>
              <TypeaheadSelect
                value={clientId}
                onValueChange={setClientId}
                options={clients.map((c) => ({ value: c.id, label: c.name }))}
                placeholder={loadingClients ? 'Loading…' : 'Search client'}
                allowNone
              />
            </div>

            <div className="space-y-2">
              <Label>Project</Label>
              <TypeaheadSelect
                value={projectId}
                onValueChange={setProjectId}
                options={projects.map((p) => ({ value: p.id, label: p.title }))}
                placeholder={
                  !clientId
                    ? 'Select a client first'
                    : loadingProjects
                      ? 'Loading…'
                      : 'Search project'
                }
                disabled={!clientId}
                allowNone
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Issue date</Label>
              <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="h-9" />
            </div>

            <div className="space-y-2">
              <Label>Due date</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="h-9" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          {items.map((it) => (
            <div key={it.id} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start rounded-md border border-border p-3">
              <div className="md:col-span-5 space-y-1">
                <Label>Item</Label>
                <Input
                  value={it.description}
                  onChange={(e) => {
                    const v = e.target.value
                    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, description: v } : x)))
                  }}
                  placeholder="e.g. Retouching"
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
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Tax" />
                    </SelectTrigger>
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
          ))}

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

      <div className="flex justify-end gap-2">
        <Button
          variant="default"
          onClick={() => void onCreate()}
          disabled={creating || loadingSettings}
        >
          {creating ? 'Creating…' : 'Create invoice'}
        </Button>
      </div>
    </div>
  )
}
