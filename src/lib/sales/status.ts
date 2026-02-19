import type { InvoiceStatus, QuoteStatus } from '@/lib/sales/types'

export function parseDateOnlyLocal(value: string | null | undefined): Date | null {
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

export function endOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

export function quoteEffectiveStatus(
  q: { status: QuoteStatus; validUntil: string | null; hasOpenedEmail?: boolean },
  nowMs: number = Date.now()
): QuoteStatus {
  if (q.status === 'CLOSED' || q.status === 'ACCEPTED') return q.status
  const validUntil = parseDateOnlyLocal(q.validUntil)
  const isExpired = Boolean(validUntil) && nowMs > endOfDayLocal(validUntil as Date).getTime()
  if (isExpired) return 'CLOSED'

  // 'OPENED' has the same display-priority as 'SENT'.
  // Only show it when the quote is otherwise effectively 'SENT'.
  if (q.status === 'SENT' && q.hasOpenedEmail) return 'OPENED'

  return q.status
}

export function invoiceEffectiveStatus(
  input: {
    status?: InvoiceStatus | null
    sentAt?: string | Date | null
    dueDate?: string | null
    totalCents: number
    paidCents: number
    hasOpenedEmail?: boolean
  },
  nowMs: number = Date.now()
): InvoiceStatus {
  const baseStatus: InvoiceStatus = input.status === 'OPEN' || input.status === 'SENT'
    ? input.status
    : (input.sentAt ? 'SENT' : 'OPEN')

  if (!Number.isFinite(input.totalCents) || input.totalCents <= 0) return baseStatus

  const paidCents = Number.isFinite(input.paidCents) ? input.paidCents : 0
  const balanceCents = Math.max(0, input.totalCents - paidCents)

  if (balanceCents <= 0) return 'PAID'

  const due = parseDateOnlyLocal(input.dueDate)
  const isPastDue = Boolean(due) && nowMs > endOfDayLocal(due as Date).getTime()
  if (isPastDue) return 'OVERDUE'
  if (paidCents > 0) return 'PARTIALLY_PAID'

  // 'OPENED' has the same display-priority as 'SENT'.
  // Only show it when the invoice is otherwise effectively 'SENT'.
  if (baseStatus === 'SENT' && input.hasOpenedEmail) return 'OPENED'

  return baseStatus
}
