'use client'

import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Send } from 'lucide-react'
import { apiPost } from '@/lib/api-client'
import { createSalesDocShareUrl } from '@/lib/sales/public-share'
import { fetchClientDetails } from '@/lib/sales/lookups'
import { fetchSalesRollup } from '@/lib/sales/admin-api'
import type { SalesInvoice, SalesQuote, SalesSettings } from '@/lib/sales/types'

type Recipient = {
  id: string
  name: string | null
  email: string | null
  isPrimary: boolean
}

function uniqStrings(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const v = String(raw || '').trim().toLowerCase()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

function extractShareToken(url: string): string | null {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1) || null
  } catch {
    return null
  }
}

export function SalesSendEmailDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  type: 'QUOTE' | 'INVOICE'
  doc: SalesQuote | SalesInvoice
  settings: SalesSettings
  clientName?: string
  projectTitle?: string
  invoicePaidAt?: string | null
  onSent?: (result: { shareToken: string; toEmails: string[]; notes: string }) => void
}) {
  const { open, onOpenChange, type, doc, settings, clientName, projectTitle, invoicePaidAt, onSent } = props

  const clientId = (doc as any)?.clientId as string | null | undefined

  const [loadingRecipients, setLoadingRecipients] = useState(false)
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const recipientsWithEmail = useMemo(
    () => recipients.filter((r) => typeof r.email === 'string' && r.email.trim().length > 0),
    [recipients]
  )

  const selectedEmails = useMemo(() => {
    const emails = recipients
      .filter((r) => selectedRecipientIds.includes(r.id))
      .map((r) => (r.email || '').trim())
      .filter(Boolean)
    return uniqStrings(emails)
  }, [recipients, selectedRecipientIds])

  useEffect(() => {
    if (!open) return

    let cancelled = false
    const load = async () => {
      setLoadingRecipients(true)
      try {
        const details = clientId ? await fetchClientDetails(clientId).catch(() => null) : null
        const list = Array.isArray(details?.recipients) ? (details!.recipients as Recipient[]) : []
        if (cancelled) return
        setRecipients(list)

        const primaryWithEmail = list.filter((r) => r.isPrimary && r.email && r.email.trim())
        const defaultSelection = (primaryWithEmail.length ? primaryWithEmail : list.filter((r) => r.email && r.email.trim()))
          .map((r) => r.id)
        setSelectedRecipientIds(defaultSelection)
      } finally {
        if (!cancelled) setLoadingRecipients(false)
      }
    }

    setMessage(null)
    void load()

    return () => {
      cancelled = true
    }
  }, [clientId, open])

  const toggleRecipient = (id: string) => {
    setSelectedRecipientIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const selectAll = () => setSelectedRecipientIds(recipientsWithEmail.map((r) => r.id))
  const selectNone = () => setSelectedRecipientIds([])

  const computeInvoicePaidAt = async (): Promise<string | null> => {
    if (type !== 'INVOICE') return null
    if (invoicePaidAt !== undefined) return invoicePaidAt ?? null

    const invoice = doc as SalesInvoice
    const r = await fetchSalesRollup({
      invoiceIds: [invoice.id],
      includeInvoices: true,
      includeQuotes: false,
      includePayments: false,
    }).catch(() => null)

    const invRollup = r?.invoiceRollupById?.[invoice.id]
    if (!invRollup) return null

    return (invRollup.totalCents > 0 && invRollup.balanceCents <= 0)
      ? (invRollup.latestPaymentYmd ?? new Date().toISOString().slice(0, 10))
      : null
  }

  const onSend = async () => {
    if (sending) return
    setMessage(null)

    if (recipientsWithEmail.length === 0) {
      setMessage({ type: 'error', text: 'No client recipients with an email address exist for this client.' })
      return
    }

    if (selectedEmails.length === 0) {
      setMessage({ type: 'error', text: 'Select at least one recipient.' })
      return
    }

    setSending(true)
    try {
      const url = await createSalesDocShareUrl({
        type,
        doc,
        settings,
        clientName,
        projectTitle,
        invoicePaidAt: type === 'INVOICE' ? await computeInvoicePaidAt() : null,
      })

      const token = extractShareToken(url)
      if (!token) throw new Error('Could not determine share token for this document.')

      const payload = {
        shareToken: token,
        toEmails: selectedEmails,
        notes: notes.trim() ? notes.trim() : null,
      }

      const res = await apiPost('/api/admin/sales/send-email', payload as any)
      if ((res as any)?.ok !== true) {
        throw new Error(typeof (res as any)?.error === 'string' ? (res as any).error : 'Failed to send email')
      }

      const failed = (res as any)?.failed
      if (Array.isArray(failed) && failed.length > 0) {
        const failedEmails = uniqStrings(
          failed
            .map((f: any) => (typeof f?.to === 'string' ? f.to : ''))
            .filter(Boolean)
        )

        if ((res as any)?.sentCount > 0) {
          onSent?.({ shareToken: token, toEmails: selectedEmails, notes: notes.trim() })
        }

        if (failedEmails.length) {
          const failedIds = recipients
            .filter((r) => r.email && failedEmails.includes(r.email.trim().toLowerCase()))
            .map((r) => r.id)
          if (failedIds.length) setSelectedRecipientIds(failedIds)
        }

        setMessage({
          type: 'error',
          text: `Sent to ${(res as any)?.sentCount ?? 0} recipient(s), but failed for: ${failedEmails.join(', ') || 'some recipients'}.`,
        })
        return
      }

      setMessage({ type: 'success', text: `Sent to ${selectedEmails.length} recipient${selectedEmails.length === 1 ? '' : 's'}.` })
      onSent?.({ shareToken: token, toEmails: selectedEmails, notes: notes.trim() })
      onOpenChange(false)
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Failed to send email' })
    } finally {
      setSending(false)
    }
  }

  const title = type === 'QUOTE' ? 'Send Quote Email' : 'Send Invoice Email'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background dark:bg-card border-border text-foreground dark:text-card-foreground max-w-[95vw] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Select Recipients</Label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={selectAll} disabled={loadingRecipients || recipientsWithEmail.length === 0}>
                  Select all
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={selectNone} disabled={loadingRecipients || selectedRecipientIds.length === 0}>
                  Select none
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              {loadingRecipients ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading recipients…
                </div>
              ) : recipients.length === 0 ? (
                <div className="text-sm text-muted-foreground">No recipients found for this client.</div>
              ) : (
                <div className="space-y-2">
                  {recipients.map((r) => {
                    const hasEmail = typeof r.email === 'string' && r.email.trim().length > 0
                    const checked = selectedRecipientIds.includes(r.id)

                    return (
                      <button
                        key={r.id}
                        type="button"
                        className="w-full flex items-center gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-muted/40 disabled:opacity-50"
                        onClick={() => hasEmail && toggleRecipient(r.id)}
                        disabled={!hasEmail}
                        title={!hasEmail ? 'Recipient has no email address' : undefined}
                      >
                        <Checkbox checked={checked} />
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">
                            {(r.name || r.email || 'Unnamed recipient') + (r.isPrimary ? ' (Primary)' : '')}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {hasEmail ? r.email : 'No email address'}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes to include in the email…"
              className="min-h-[110px]"
              disabled={sending}
            />
          </div>

          {message ? (
            <div className={message.type === 'error' ? 'text-sm text-red-600' : 'text-sm text-green-600'}>
              {message.text}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void onSend()} disabled={sending || loadingRecipients}>
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" /> Send
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
