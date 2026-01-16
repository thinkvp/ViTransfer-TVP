import type { SalesInvoice, SalesLineItem, SalesPayment, SalesQuote, SalesSettings } from '@/lib/sales/types'

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function iso(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  const maybe = (value as any)?.toISOString?.()
  return typeof maybe === 'string' ? maybe : new Date(0).toISOString()
}

export type DbSalesQuote = {
  id: string
  quoteNumber: string
  status: string
  acceptedFromStatus: string | null
  clientId: string
  projectId: string | null
  issueDate: string
  validUntil: string | null
  notes: string
  terms: string
  itemsJson: unknown
  sentAt: Date | null
  remindersEnabled: boolean
  lastExpiryReminderSentYmd: string | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export type DbSalesInvoice = {
  id: string
  invoiceNumber: string
  status: string
  clientId: string
  projectId: string | null
  issueDate: string
  dueDate: string | null
  notes: string
  terms: string
  itemsJson: unknown
  sentAt: Date | null
  remindersEnabled: boolean
  lastOverdueReminderSentYmd: string | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export type DbSalesPayment = {
  id: string
  paymentDate: string
  amountCents: number
  method: string
  reference: string
  clientId: string | null
  invoiceId: string | null
  createdAt: Date
  updatedAt: Date
  source: string
}

export type DbSalesSettings = {
  id: string
  businessName: string
  address: string
  abn: string
  phone: string
  email: string
  website: string
  taxRatePercent: number
  defaultQuoteValidDays: number
  defaultInvoiceDueDays: number
  defaultTerms: string
  paymentDetails: string
  createdAt: Date
  updatedAt: Date
}

export type SalesQuoteWithVersion = SalesQuote & { version: number }
export type SalesInvoiceWithVersion = SalesInvoice & { version: number }
export type SalesPaymentWithMeta = SalesPayment & { updatedAt?: string; source?: string }

export function salesQuoteFromDb(row: DbSalesQuote): SalesQuoteWithVersion {
  return {
    id: row.id,
    quoteNumber: row.quoteNumber,
    status: row.status as any,
    acceptedFromStatus: row.acceptedFromStatus as any,
    clientId: row.clientId,
    projectId: row.projectId,
    issueDate: row.issueDate,
    validUntil: row.validUntil,
    notes: row.notes ?? '',
    terms: row.terms ?? '',
    items: asArray<SalesLineItem>(row.itemsJson),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    sentAt: row.sentAt ? iso(row.sentAt) : null,
    remindersEnabled: row.remindersEnabled,
    lastExpiryReminderSentYmd: row.lastExpiryReminderSentYmd,
    version: Number.isFinite(Number(row.version)) ? Math.max(1, Math.trunc(Number(row.version))) : 1,
  }
}

export function salesInvoiceFromDb(row: DbSalesInvoice): SalesInvoiceWithVersion {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    status: row.status as any,
    clientId: row.clientId,
    projectId: row.projectId,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    notes: row.notes ?? '',
    terms: row.terms ?? '',
    items: asArray<SalesLineItem>(row.itemsJson),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    sentAt: row.sentAt ? iso(row.sentAt) : null,
    remindersEnabled: row.remindersEnabled,
    lastOverdueReminderSentYmd: row.lastOverdueReminderSentYmd,
    version: Number.isFinite(Number(row.version)) ? Math.max(1, Math.trunc(Number(row.version))) : 1,
  }
}

export function salesPaymentFromDb(row: DbSalesPayment): SalesPaymentWithMeta {
  return {
    id: row.id,
    paymentDate: row.paymentDate,
    amountCents: row.amountCents,
    method: row.method ?? '',
    reference: row.reference ?? '',
    clientId: row.clientId,
    invoiceId: row.invoiceId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    source: typeof row.source === 'string' ? row.source : undefined,
  }
}

export function salesSettingsFromDb(row: DbSalesSettings): SalesSettings {
  return {
    businessName: row.businessName ?? '',
    address: row.address ?? '',
    abn: row.abn ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    website: row.website ?? '',
    taxRatePercent: Number(row.taxRatePercent ?? 10),
    defaultQuoteValidDays: Number(row.defaultQuoteValidDays ?? 14),
    defaultInvoiceDueDays: Number(row.defaultInvoiceDueDays ?? 7),
    defaultTerms: row.defaultTerms ?? 'Payment due within 7 days unless otherwise agreed.',
    paymentDetails: row.paymentDetails ?? '',
    updatedAt: iso(row.updatedAt),
  }
}
