'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api-client'
import type { BankTransaction } from '@/lib/accounting/types'
import { cn, formatDate } from '@/lib/utils'
import { Loader2, Paperclip } from 'lucide-react'

function fmtAud(cents: number) {
  const abs = Math.abs(cents)
  return (cents < 0 ? '-' : '') + '$' + (abs / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const TRANSACTION_STATUS_LABELS: Record<string, string> = {
  UNMATCHED: 'Pending',
  MATCHED: 'Posted',
  EXCLUDED: 'Ignored',
}

const TRANSACTION_STATUS_BADGES: Record<string, string> = {
  UNMATCHED: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  MATCHED: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  EXCLUDED: 'bg-muted text-muted-foreground',
}

interface LinkedBankTransactionDialogProps {
  open: boolean
  transactionId: string | null
  onOpenChange: (open: boolean) => void
  onViewExpense?: (expenseId: string) => void
}

export function LinkedBankTransactionDialog({ open, transactionId, onOpenChange, onViewExpense }: LinkedBankTransactionDialogProps) {
  const [transaction, setTransaction] = useState<BankTransaction | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !transactionId) {
      setTransaction(null)
      setError('')
      setLoading(false)
      return
    }

    let cancelled = false
    setTransaction(null)
    setError('')
    setLoading(true)

    void (async () => {
      try {
        const res = await apiFetch(`/api/admin/accounting/transactions/${transactionId}`)
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          if (!cancelled) setError(d.error || 'Failed to load linked bank transaction')
          return
        }
        const d = await res.json()
        if (!cancelled) setTransaction(d.transaction ?? null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [open, transactionId])

  async function downloadAccountingAttachment(attachmentId: string, filename: string) {
    try {
      const res = await apiFetch(`/api/admin/accounting/attachments/${attachmentId}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error || 'Failed to download attachment')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch {
      alert('Failed to download attachment')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Linked Bank Transaction</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />Loading transaction...
          </div>
        ) : error ? (
          <div className="py-6 text-sm text-destructive">{error}</div>
        ) : transaction ? (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('text-xs px-1.5 py-0.5 rounded', TRANSACTION_STATUS_BADGES[transaction.status] ?? 'bg-muted text-muted-foreground')}>
                {TRANSACTION_STATUS_LABELS[transaction.status] ?? transaction.status}
              </span>
              {transaction.transactionType && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-400">
                  {transaction.transactionType}
                </span>
              )}
              {transaction.matchType === 'SPLIT' && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  Split
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Date</p>
                <p>{formatDate(transaction.date)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Amount</p>
                <p className="tabular-nums font-medium">{fmtAud(transaction.amountCents)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Bank Account</p>
                <p>{transaction.bankAccountName ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Reference</p>
                <p>{transaction.reference ?? '—'}</p>
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground">Description</p>
              <p className="whitespace-normal break-words">{transaction.description}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Posting Account</p>
                <p>{transaction.accountName ?? transaction.expense?.accountName ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">GST</p>
                <p>{transaction.taxCode ?? '—'}</p>
              </div>
            </div>

            {transaction.memo && (
              <div>
                <p className="text-xs text-muted-foreground">Memo</p>
                <p className="whitespace-normal break-words">{transaction.memo}</p>
              </div>
            )}

            {transaction.invoicePayment?.invoiceId && (
              <div>
                <p className="text-xs text-muted-foreground">Invoice</p>
                <Link href={`/admin/sales/invoices/${transaction.invoicePayment.invoiceId}`} className="text-primary hover:underline underline-offset-2">
                  {transaction.invoicePayment.invoiceNumber ?? transaction.invoicePayment.invoiceId}
                  {transaction.invoicePayment.clientName ? ` — ${transaction.invoicePayment.clientName}` : ''}
                </Link>
              </div>
            )}

            {transaction.expense && (
              <div>
                <p className="text-xs text-muted-foreground">Linked Expense</p>
                {onViewExpense ? (
                  <button type="button" onClick={() => onViewExpense(transaction.expense!.id)} className="text-left text-primary hover:underline underline-offset-2">
                    {transaction.expense.supplierName ? `${transaction.expense.supplierName} — ` : ''}{transaction.expense.description}
                  </button>
                ) : (
                  <p>{transaction.expense.supplierName ? `${transaction.expense.supplierName} — ` : ''}{transaction.expense.description}</p>
                )}
              </div>
            )}

            {(transaction.splitLines?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Split Lines</p>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Account</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Description</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">GST</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transaction.splitLines!.map(line => (
                        <tr key={line.id} className="border-t border-border">
                          <td className="px-3 py-2">{line.accountName ?? '—'}</td>
                          <td className="px-3 py-2">{line.description || '—'}</td>
                          <td className="px-3 py-2">{line.taxCode}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtAud(line.amountCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(transaction.attachments?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Attachments</p>
                <div className="flex flex-col gap-1.5">
                  {transaction.attachments!.map(attachment => (
                    <button
                      key={attachment.id}
                      type="button"
                      onClick={() => void downloadAccountingAttachment(attachment.id, attachment.originalName)}
                      className="flex items-center gap-2 text-left text-primary hover:underline underline-offset-2"
                    >
                      <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{attachment.originalName}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="py-6 text-sm text-muted-foreground">No linked bank transaction found.</div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}