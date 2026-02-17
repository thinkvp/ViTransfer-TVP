import type { InvoiceStatus, QuoteStatus } from './types'

export function invoiceStatusBadgeClass(status: InvoiceStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-blue-600 text-white'
    case 'SENT':
      return 'bg-purple-600 text-white'
    case 'OVERDUE':
      return 'bg-amber-600 text-white'
    case 'PARTIALLY_PAID':
      return 'bg-cyan-600 text-white'
    case 'PAID':
      return 'bg-emerald-600 text-white'
  }
}

export function invoiceStatusLabel(status: InvoiceStatus): string {
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

export function quoteStatusBadgeClass(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'bg-blue-600 text-white'
    case 'SENT':
      return 'bg-purple-600 text-white'
    case 'ACCEPTED':
      return 'bg-emerald-600 text-white'
    case 'CLOSED':
      return 'bg-slate-500 text-white'
  }
}

export function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'SENT':
      return 'Sent'
    case 'ACCEPTED':
      return 'Accepted'
    case 'CLOSED':
      return 'Closed'
  }
}
