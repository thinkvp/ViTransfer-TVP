'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Receipt, Trash2, Plus } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createSalesQuote, createSalesInvoice, patchSalesQuote, patchSalesInvoice } from '@/lib/sales/admin-api'
import { formatMoney } from '@/lib/sales/money'
import type { SalesProposal, ResolvedSalesLineItem } from '@/lib/ai/proposal-schemas'
import { ClientPicker, initialClientChoice, type ClientChoice } from './ClientPicker'
import { createClientViaApi, type ClientOption, type UpdateTarget } from './helpers'

interface EditableItem {
  description: string
  details: string
  quantity: number
  unitPriceCents: number
  taxRatePercent: number
  // Library/label snapshot resolved by the worker guards — passed through to the document
  libraryItemId: string | null
  taxRateName: string | null
  labelId: string | null
  labelName: string | null
  labelColor: string | null
}

interface SalesProposalCardProps {
  proposal: SalesProposal
  clients: ClientOption[]
  onClientCreated: (client: ClientOption) => void
  /** Set once the project card has created its project — links the documents to it */
  linkedProjectId: string | null
  /** When set, this card revises an existing quote/invoice (PATCH) instead of creating */
  updateTarget?: UpdateTarget | null
}

export function SalesProposalCard({ proposal, clients, onClientCreated, linkedProjectId, updateTarget }: SalesProposalCardProps) {
  const [docType, setDocType] = useState<SalesProposal['docType']>(proposal.docType)
  const [clientChoice, setClientChoice] = useState<ClientChoice>(() => initialClientChoice(proposal.client, clients))
  const [issueDate, setIssueDate] = useState(proposal.issueDate)
  const [validUntil, setValidUntil] = useState(proposal.validUntil ?? '')
  const [dueDate, setDueDate] = useState(proposal.dueDate ?? '')
  const [notes, setNotes] = useState(proposal.notes ?? '')
  const [terms, setTerms] = useState(proposal.terms ?? '')
  const [items, setItems] = useState<EditableItem[]>(
    (proposal.items as ResolvedSalesLineItem[]).map((i) => ({
      description: i.description,
      details: i.details ?? '',
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      taxRatePercent: i.taxRatePercent,
      libraryItemId: i.libraryItemId ?? null,
      taxRateName: i.taxRateName ?? null,
      labelId: i.labelId ?? null,
      labelName: i.labelName ?? null,
      labelColor: i.labelColor ?? null,
    }))
  )

  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [createdQuoteId, setCreatedQuoteId] = useState<string | null>(null)
  const [createdInvoiceId, setCreatedInvoiceId] = useState<string | null>(null)
  const [updated, setUpdated] = useState(false)

  const isUpdate = updateTarget != null

  const subtotalCents = items.reduce((sum, i) => sum + Math.round(i.quantity * i.unitPriceCents), 0)
  const taxCents = items.reduce(
    (sum, i) => sum + Math.round((i.quantity * i.unitPriceCents * i.taxRatePercent) / 100),
    0
  )

  const wantQuote = docType === 'QUOTE' || docType === 'BOTH'
  const wantInvoice = docType === 'INVOICE' || docType === 'BOTH'
  const done = (!wantQuote || createdQuoteId != null) && (!wantInvoice || createdInvoiceId != null) && (createdQuoteId != null || createdInvoiceId != null)
  const disabled = creating || (isUpdate ? updated : done)

  async function handleCreate() {
    setError('')
    setCreating(true)
    try {
      let clientId: string
      if (clientChoice.mode === 'new') {
        if (!clientChoice.name.trim()) throw new Error('New client name is required')
        const client = await createClientViaApi({
          name: clientChoice.name.trim(),
          address: clientChoice.address.trim() || null,
          phone: clientChoice.phone.trim() || null,
          website: clientChoice.website.trim() || null,
          recipients: clientChoice.recipients,
        })
        onClientCreated(client)
        setClientChoice({ mode: 'existing', clientId: client.id })
        clientId = client.id
      } else {
        clientId = clientChoice.clientId
        if (!clientId) throw new Error('Select a client first')
      }

      const payloadItems = items.map((item, index) => ({
        id: `li-${index + 1}`,
        description: item.description,
        details: item.details || undefined,
        quantity: item.quantity,
        unitPriceCents: Math.trunc(item.unitPriceCents),
        taxRatePercent: item.taxRatePercent,
        taxRateName: item.taxRateName ?? undefined,
        // Sales label snapshot (rides through lineItemsSchema's passthrough)
        labelId: item.labelId,
        labelName: item.labelName,
        labelColor: item.labelColor,
      }))

      // Update mode: PATCH the existing document (projectId omitted → preserved)
      if (isUpdate && updateTarget) {
        const patch = {
          version: updateTarget.version,
          clientId,
          issueDate,
          notes: notes || '',
          terms: terms || '',
          items: payloadItems,
        }
        try {
          if (updateTarget.type === 'quote') {
            await patchSalesQuote(updateTarget.id, { ...patch, validUntil: validUntil || null })
          } else {
            await patchSalesInvoice(updateTarget.id, { ...patch, dueDate: dueDate || null })
          }
          setUpdated(true)
        } catch (e) {
          const msg = e instanceof Error ? e.message : ''
          if (msg.includes('409') || /version/i.test(msg)) {
            throw new Error('This document changed since you loaded it. Reload it and re-apply your change.')
          }
          throw e
        }
        return
      }

      if (wantQuote && !createdQuoteId) {
        const quote = await createSalesQuote({
          clientId,
          projectId: linkedProjectId,
          issueDate,
          validUntil: validUntil || null,
          notes: notes || null,
          terms: terms || null,
          items: payloadItems,
        })
        setCreatedQuoteId(quote.id)
      }
      if (wantInvoice && !createdInvoiceId) {
        const invoice = await createSalesInvoice({
          clientId,
          projectId: linkedProjectId,
          issueDate,
          dueDate: dueDate || null,
          notes: notes || null,
          terms: terms || null,
          items: payloadItems,
        })
        setCreatedInvoiceId(invoice.id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Document creation failed')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Card className="border-border">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <Receipt className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <CardTitle>
              {isUpdate
                ? `Revise ${updateTarget!.number}`
                : docType === 'BOTH'
                  ? 'Quote & invoice proposal'
                  : docType === 'INVOICE'
                    ? 'Invoice proposal'
                    : 'Quote proposal'}
            </CardTitle>
            <CardDescription>
              {isUpdate
                ? 'Review the revised document, then Update to save the changes to the existing record.'
                : 'Documents are created as unsent (OPEN) drafts — review and send them from the Sales pages.'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 border-t pt-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label htmlFor="ai-sales-doctype">Document</Label>
            <Select
              value={docType}
              disabled={disabled || isUpdate}
              onValueChange={(value) => setDocType(value as SalesProposal['docType'])}
            >
              <SelectTrigger id="ai-sales-doctype">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="QUOTE">Quote</SelectItem>
                <SelectItem value="INVOICE">Invoice</SelectItem>
                {!isUpdate && <SelectItem value="BOTH">Quote + Invoice</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-sales-issue">Issue date</Label>
            <Input id="ai-sales-issue" type="date" value={issueDate} disabled={disabled} onChange={(e) => setIssueDate(e.target.value)} />
          </div>
          {wantQuote && (
            <div className="space-y-1">
              <Label htmlFor="ai-sales-valid">Quote valid until</Label>
              <Input id="ai-sales-valid" type="date" value={validUntil} disabled={disabled} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          )}
          {wantInvoice && (
            <div className="space-y-1">
              <Label htmlFor="ai-sales-due">Invoice due date</Label>
              <Input id="ai-sales-due" type="date" value={dueDate} disabled={disabled} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          )}
        </div>

        <ClientPicker
          idPrefix="ai-sales"
          choice={clientChoice}
          setChoice={setClientChoice}
          clients={clients}
          matchConfidence={proposal.client.matchConfidence}
          disabled={disabled}
        />

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Line items</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                setItems([
                  ...items,
                  {
                    description: '',
                    details: '',
                    quantity: 1,
                    unitPriceCents: 0,
                    taxRatePercent: 10,
                    libraryItemId: null,
                    taxRateName: null,
                    labelId: null,
                    labelName: null,
                    labelColor: null,
                  },
                ])
              }
            >
              <Plus className="w-4 h-4 mr-1" /> Add item
            </Button>
          </div>
          {items.map((item, i) => (
            <div key={i} className="border rounded-lg p-3 bg-muted/30 space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={item.description}
                  placeholder="Description"
                  disabled={disabled}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
                {item.labelName && (
                  <span
                    className="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border"
                    style={item.labelColor ? { borderColor: item.labelColor, color: item.labelColor } : undefined}
                    title={item.libraryItemId ? 'From the Line Item Library (library pricing applied)' : 'Sales label'}
                  >
                    {item.labelName}
                  </span>
                )}
                <Button type="button" variant="ghost" size="icon" disabled={disabled} onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Qty</Label>
                  <Input
                    type="number"
                    value={item.quantity}
                    disabled={disabled}
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) || 0 } : x)))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Unit price ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={(item.unitPriceCents / 100).toString()}
                    disabled={disabled}
                    onChange={(e) =>
                      setItems(items.map((x, j) => (j === i ? { ...x, unitPriceCents: Math.round((Number(e.target.value) || 0) * 100) } : x)))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Tax %</Label>
                  <Input
                    type="number"
                    value={item.taxRatePercent}
                    disabled={disabled}
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, taxRatePercent: Number(e.target.value) || 0 } : x)))}
                  />
                </div>
              </div>
            </div>
          ))}
          <div className="flex justify-end">
            <div className="w-full sm:w-64 space-y-1.5 rounded-lg border bg-muted/20 p-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatMoney(subtotalCents)}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>GST</span>
                <span className="tabular-nums">{formatMoney(taxCents)}</span>
              </div>
              <div className="flex justify-between border-t pt-1.5 font-medium">
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(subtotalCents + taxCents)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="ai-sales-notes">Notes</Label>
            <Textarea id="ai-sales-notes" rows={2} value={notes} disabled={disabled} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-sales-terms">Terms</Label>
            <Textarea id="ai-sales-terms" rows={2} value={terms} disabled={disabled} onChange={(e) => setTerms(e.target.value)} />
          </div>
        </div>

        {!isUpdate && linkedProjectId && (
          <p className="text-xs text-muted-foreground">Will be linked to the project created above.</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3">
          {isUpdate ? (
            <>
              {!updated && (
                <Button type="button" onClick={handleCreate} disabled={creating || items.length === 0}>
                  {creating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Updating…
                    </>
                  ) : (
                    `Update ${updateTarget!.number}`
                  )}
                </Button>
              )}
              {updated && (
                <Button asChild variant="outline">
                  <Link href={`/admin/sales/${updateTarget!.type === 'quote' ? 'quotes' : 'invoices'}/${updateTarget!.id}`}>
                    Open {updateTarget!.type}
                  </Link>
                </Button>
              )}
            </>
          ) : (
            <>
              {!done && (
                <Button type="button" onClick={handleCreate} disabled={creating || items.length === 0}>
                  {creating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    `Create ${docType === 'BOTH' ? 'quote + invoice' : docType.toLowerCase()}`
                  )}
                </Button>
              )}
              {createdQuoteId && (
                <Button asChild variant="outline">
                  <Link href={`/admin/sales/quotes/${createdQuoteId}`}>Open quote</Link>
                </Button>
              )}
              {createdInvoiceId && (
                <Button asChild variant="outline">
                  <Link href={`/admin/sales/invoices/${createdInvoiceId}`}>Open invoice</Link>
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
