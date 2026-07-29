'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api-client'
import type { Account } from '@/lib/accounting/types'
import { cn, formatDate } from '@/lib/utils'
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from 'lucide-react'
import {
  ENTRY_KIND_BADGE,
  fmtAud,
  getEntryAmountExGst,
  getEntryDate,
  getEntryDescription,
  getEntryReference,
  type AccountLedgerEntry,
} from './account-ledger-entries'

const PAGE_SIZE = 50

interface AccountEntriesDialogProps {
  open: boolean
  /** Account id or code — the entries API resolves either. */
  accountRef: string | null
  /** Shown in the title until the account loads. */
  accountLabel?: string
  from?: string
  to?: string
  onOpenChange: (open: boolean) => void
}

export function AccountEntriesDialog({ open, accountRef, accountLabel, from, to, onOpenChange }: AccountEntriesDialogProps) {
  const [account, setAccount] = useState<Account | null>(null)
  const [entries, setEntries] = useState<AccountLedgerEntry[]>([])
  const [total, setTotal] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [periodTotalCents, setPeriodTotalCents] = useState(0)
  const [taxRatePercent, setTaxRatePercent] = useState(10)
  const [hasChildAccounts, setHasChildAccounts] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Reset paging whenever the dialog targets a different account or period.
  useEffect(() => { setPage(1) }, [accountRef, from, to])

  useEffect(() => {
    if (!open || !accountRef) {
      setEntries([])
      setAccount(null)
      setError('')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError('')

    void (async () => {
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
        if (from) params.set('from', from)
        if (to) params.set('to', to)
        const res = await apiFetch(`/api/admin/accounting/accounts/${encodeURIComponent(accountRef)}/entries?${params}`)
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          if (!cancelled) setError(d.error || 'Failed to load account entries')
          return
        }
        const d = await res.json()
        if (cancelled) return
        setAccount(d.account ?? null)
        setEntries(d.entries ?? [])
        setTotal(d.total ?? 0)
        setPeriodTotalCents(d.periodTotalCents ?? 0)
        setTaxRatePercent(d.taxRatePercent ?? 10)
        setHasChildAccounts(d.hasChildAccounts ?? false)
        setPageCount(d.pageCount ?? 1)
      } catch {
        if (!cancelled) setError('Failed to load account entries')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [open, accountRef, from, to, page])

  const ledgerHref = accountRef
    ? `/admin/accounting/chart-of-accounts/${encodeURIComponent(accountRef)}${from && to ? `?from=${from}&to=${to}` : ''}`
    : '#'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,72rem)] max-w-5xl max-h-[88vh] overflow-hidden p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 space-y-1">
          <DialogTitle className="pr-8 text-base">
            {account ? `${account.code} — ${account.name}` : accountLabel ?? 'Account Entries'}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {from && to ? `${formatDate(from)} to ${formatDate(to)} · ` : ''}All figures ex GST
            {hasChildAccounts ? ' · Includes sub-accounts' : ''}
          </p>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto border-y border-border">
          {loading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />Loading…
            </div>
          ) : error ? (
            <div className="py-12 text-center text-sm text-destructive">{error}</div>
          ) : entries.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No entries found.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 sticky top-0 z-10">
                <tr className="border-b border-border">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap">Type</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Description</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Ref / Supplier</th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted-foreground w-32 whitespace-nowrap">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((row, i) => {
                  const badge = ENTRY_KIND_BADGE[row.kind]
                  const reference = getEntryReference(row)
                  return (
                    <tr key={`${row.kind}-${row.entry.id}-${i}`} className="hover:bg-accent/20 transition-colors align-top">
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground text-xs whitespace-nowrap">{formatDate(getEntryDate(row))}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span className={cn('text-xs px-1.5 py-0.5 rounded', badge.className)}>{badge.label}</span>
                      </td>
                      <td className="px-4 py-2.5 whitespace-normal wrap-break-word">{getEntryDescription(row)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-normal wrap-break-word">{reference ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                        {fmtAud(getEntryAmountExGst(row, account?.type, taxRatePercent))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30">
                  <td colSpan={4} className="px-4 py-2.5 text-right text-sm font-semibold text-foreground">
                    {pageCount > 1 ? 'Period Total ex-GST (all pages)' : 'Period Total (ex-GST)'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-foreground whitespace-nowrap">{fmtAud(periodTotalCents)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <DialogFooter className="px-5 py-3 sm:justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{total} total</span>
            {pageCount > 1 && (
              <span className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <span className="text-xs">Page {page} of {pageCount}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= pageCount || loading} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link href={ledgerHref}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <ExternalLink className="w-3.5 h-3.5" />Open full ledger
              </Button>
            </Link>
            <Button size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
