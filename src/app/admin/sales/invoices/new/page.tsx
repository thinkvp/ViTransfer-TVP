'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { TypeaheadSelect } from '@/components/sales/TypeaheadSelect'
import { TaxRateSelect } from '@/components/sales/TaxRateSelect'
import { createSalesInvoice, fetchSalesSettings, fetchTaxRates } from '@/lib/sales/admin-api'
import { SalesLineItemPresetsModal } from '@/components/admin/sales/SalesLineItemPresetsModal'
import type { ClientOption, ProjectOption, SalesLineItem, SalesSettings, SalesTaxRate } from '@/lib/sales/types'
import { fetchClientOptions, fetchProjectOptionsForClient } from '@/lib/sales/lookups'
import {
  calcLineSubtotalCents,
  centsToDollars,
  dollarsToCents,
  formatMoney,
  sumLineItemsSubtotal,
  sumLineItemsTax,
} from '@/lib/sales/money'
import { getCurrencySymbol } from '@/lib/sales/currency'

function getTodayYmdLocal(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function normalizeTaxRatePercent(rate: unknown, defaultRate: number): number {
  const n = Number(rate)
  return Number.isFinite(n) && n >= 0 ? n : defaultRate
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00`)
  if (!Number.isFinite(d.getTime())) return ''
  d.setDate(d.getDate() + (Number.isFinite(days) ? days : 0))
  return d.toISOString().slice(0, 10)
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

  const [notes, setNotes] = useState<string>('')
  const [terms, setTerms] = useState<string>('')
  const [items, setItems] = useState<SalesLineItem[]>(() => [newLineItem(10)])
  const [taxRates, setTaxRates] = useState<SalesTaxRate[]>([])
  const dragEnabledRef = useRef(false)
  const dragIndexRef = useRef<number | null>(null)
  const dragOverIndexRef = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [showPresetsModal, setShowPresetsModal] = useState(false)

  // Read prefill data placed by the duplicate button on the edit page
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('sales_invoice_prefill')
      if (!raw) return
      sessionStorage.removeItem('sales_invoice_prefill')
      const prefill = JSON.parse(raw) as { notes?: string; terms?: string; items?: SalesLineItem[] }
      if (prefill.notes !== undefined) setNotes(prefill.notes)
      if (prefill.terms !== undefined) setTerms(prefill.terms)
      if (Array.isArray(prefill.items) && prefill.items.length > 0) {
        setItems(prefill.items.map((it) => ({
          ...it,
          id: globalThis.crypto?.randomUUID?.() ?? `li-${Date.now()}-${Math.random()}`,
        })))
      }
    } catch {
      // ignore parse/storage errors
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoadingSettings(true)
    ;(async () => {
      try {
        const [s, rates] = await Promise.all([fetchSalesSettings(), fetchTaxRates()])
        if (cancelled) return
        setSettings(s)
        setTaxRates(rates)
        setTerms((prev) => (prev ? prev : s.defaultTerms))
        const primaryRate = rates.find((r) => r.isDefault)
        setItems((prev) => {
          if (!prev.length) return [newLineItem(s.taxRatePercent, primaryRate?.name)]
          // Update default tax rate on initial items that still have the placeholder rate
          return prev.map((it) => ({
            ...it,
            taxRatePercent: normalizeTaxRatePercent(it.taxRatePercent === 10 ? s.taxRatePercent : it.taxRatePercent, s.taxRatePercent),
            taxRateName: it.taxRateName || primaryRate?.name,
          }))
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
  const totalCents = subtotalCents + (settings.taxEnabled ? taxCents : 0)

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
          quantity: Number.isFinite(it.quantity) && it.quantity >= 0 ? it.quantity : 1,
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
          {items.map((it, idx) => (
            <div
              key={it.id}
              draggable
              onDragStart={(e) => {
                if (!dragEnabledRef.current) { e.preventDefault(); return }
                dragIndexRef.current = idx
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                dragEnabledRef.current = false
                dragIndexRef.current = null
                dragOverIndexRef.current = null
                setDragOverIndex(null)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                dragOverIndexRef.current = idx
                setDragOverIndex(idx)
              }}
              onDragLeave={() => {
                if (dragOverIndexRef.current === idx) setDragOverIndex(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                const from = dragIndexRef.current
                const to = dragOverIndexRef.current
                if (from !== null && to !== null && from !== to) {
                  setItems((prev) => {
                    const next = [...prev]
                    const [moved] = next.splice(from, 1)
                    next.splice(to, 0, moved)
                    return next
                  })
                }
                dragIndexRef.current = null
                dragOverIndexRef.current = null
                setDragOverIndex(null)
              }}
              className={`grid grid-cols-1 md:grid-cols-[auto_minmax(0,5fr)_minmax(0,3fr)_minmax(0,4fr)] gap-2 items-start rounded-md border border-border p-3${dragOverIndex === idx && dragIndexRef.current !== idx ? ' ring-2 ring-primary/50' : ''}`}
            >
              <div
                className="hidden md:flex items-center self-stretch cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
                onMouseDown={() => { dragEnabledRef.current = true }}
                onMouseUp={() => { dragEnabledRef.current = false }}
              >
                <GripVertical className="w-4 h-4" />
              </div>
              <div className="space-y-1">
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

              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                <div className="space-y-1 md:col-span-1">
                  <Label>Qty</Label>
                  <Input
                    type="number"
                    value={String(it.quantity)}
                    min={0}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, quantity: Number.isFinite(v) && v >= 0 ? v : 0 } : x)))
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

              {settings.taxEnabled && (
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

              {!settings.taxEnabled && (
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
          ))}

          <div className="flex justify-between items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" onClick={() => setShowPresetsModal(true)}>
                Add items
              </Button>
              <Button variant="outline" onClick={() => { const pr = taxRates.find((r) => r.isDefault); setItems((prev) => [...prev, newLineItem(settings.taxRatePercent, pr?.name)]) }}>
                Add line
              </Button>
            </div>
            <div className="text-sm">
              <div className="flex items-center justify-end gap-3">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="text-foreground font-medium tabular-nums">{formatMoney(subtotalCents, getCurrencySymbol(settings.currencyCode))}</span>
              </div>
              {settings.taxEnabled && (
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

      <div className="flex justify-end gap-2">
        <Button
          variant="default"
          onClick={() => void onCreate()}
          disabled={creating || loadingSettings}
        >
          {creating ? 'Creating…' : 'Create invoice'}
        </Button>
      </div>

      <SalesLineItemPresetsModal
        open={showPresetsModal}
        onOpenChange={setShowPresetsModal}
        taxRates={taxRates}
        defaultTaxRatePercent={settings.taxRatePercent}
        currencySymbol={getCurrencySymbol(settings.currencyCode)}
        onImport={(newItems) => setItems((prev) => {
          // Remove unchanged default empty item slots before appending
          const meaningful = prev.filter((it) => it.description.trim() !== '' || it.unitPriceCents !== 0)
          return [...meaningful, ...newItems]
        })}
      />
    </div>
  )
}
