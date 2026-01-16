import type { SalesInvoice, SalesPayment, SalesQuote, SalesSettings } from '@/lib/sales/types'

export const SALES_NATIVE_STORE_CHANGED_EVENT = 'vitransfer:sales-native-store-changed'

const KEYS = {
  quotes: 'vitransfer.sales.quotes',
  invoices: 'vitransfer.sales.invoices',
  payments: 'vitransfer.sales.payments',
  settings: 'vitransfer.sales.settings',
  seq: 'vitransfer.sales.seq',
} as const

type SeqState = {
  quote: number
  invoice: number
}

export type SalesSeqState = SeqState

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10)
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function assertBrowser(): void {
  if (!isBrowser()) throw new Error('Sales storage is only available in the browser')
}

function emitSalesNativeStoreChanged(): void {
  if (!isBrowser()) return
  try {
    window.dispatchEvent(new CustomEvent(SALES_NATIVE_STORE_CHANGED_EVENT))
  } catch {
    // ignore
  }
}

function readSeq(): SeqState {
  if (!isBrowser()) return { quote: 0, invoice: 0 }
  return safeJsonParse<SeqState>(localStorage.getItem(KEYS.seq), { quote: 0, invoice: 0 })
}

function writeSeq(next: SeqState): void {
  assertBrowser()
  localStorage.setItem(KEYS.seq, JSON.stringify(next))
  emitSalesNativeStoreChanged()
}

export function getSalesSeqState(): SeqState {
  return readSeq()
}

export function setSalesSeqState(next: SeqState): SeqState {
  assertBrowser()
  const quote = Number.isFinite(next.quote) && next.quote >= 0 ? Math.trunc(next.quote) : 0
  const invoice = Number.isFinite(next.invoice) && next.invoice >= 0 ? Math.trunc(next.invoice) : 0
  const normalized: SeqState = { quote, invoice }
  writeSeq(normalized)
  return normalized
}

function nextNumber(kind: keyof SeqState): string {
  const seq = readSeq()
  const next = { ...seq, [kind]: (seq[kind] ?? 0) + 1 }
  writeSeq(next)
  const value = next[kind]
  return String(value).padStart(6, '0')
}

function readList<T>(key: string): T[] {
  if (!isBrowser()) return []
  const list = safeJsonParse<T[]>(localStorage.getItem(key), [])
  return Array.isArray(list) ? list : []
}

function writeList<T>(key: string, list: T[]): void {
  assertBrowser()
  localStorage.setItem(key, JSON.stringify(list))
  emitSalesNativeStoreChanged()
}

export function listQuotes(): SalesQuote[] {
  return readList<SalesQuote>(KEYS.quotes)
}

export function upsertQuote(quote: SalesQuote): SalesQuote {
  assertBrowser()
  const quotes = listQuotes()
  const idx = quotes.findIndex((q) => q.id === quote.id)

  const now = nowIso()
  const base = idx >= 0 ? quotes[idx] : null
  const next: SalesQuote = {
    ...(base ?? quote),
    ...quote,
    createdAt: base?.createdAt ?? quote.createdAt ?? now,
    updatedAt: now,
    sentAt: base?.sentAt ?? quote.sentAt ?? null,
  }

  const out = [...quotes]
  if (idx >= 0) out[idx] = next
  else out.unshift(next)
  writeList(KEYS.quotes, out)
  return next
}

export function getQuote(id: string): SalesQuote | null {
  return listQuotes().find((q) => q.id === id) ?? null
}

export function createQuote(input: Omit<SalesQuote, 'id' | 'quoteNumber' | 'createdAt' | 'updatedAt' | 'sentAt'>): SalesQuote {
  assertBrowser()
  const id = globalThis.crypto?.randomUUID?.() ?? `quote-${Date.now()}`
  const quoteNumber = `EST-${nextNumber('quote')}`
  const now = nowIso()
  const quote: SalesQuote = {
    ...input,
    id,
    quoteNumber,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    remindersEnabled: (input as any)?.remindersEnabled !== false,
  }

  const next = [quote, ...listQuotes()]
  writeList(KEYS.quotes, next)
  return quote
}

export function updateQuote(id: string, patch: Partial<SalesQuote>): SalesQuote {
  assertBrowser()
  const quotes = listQuotes()
  const idx = quotes.findIndex((q) => q.id === id)
  if (idx < 0) throw new Error('Quote not found')

  const next: SalesQuote = { ...quotes[idx], ...patch, updatedAt: nowIso() }
  const out = [...quotes]
  out[idx] = next
  writeList(KEYS.quotes, out)
  return next
}

export function deleteQuote(id: string): void {
  assertBrowser()
  writeList(KEYS.quotes, listQuotes().filter((q) => q.id !== id))
}

export function listInvoices(): SalesInvoice[] {
  return readList<SalesInvoice>(KEYS.invoices)
}

export function upsertInvoice(invoice: SalesInvoice): SalesInvoice {
  assertBrowser()
  const invoices = listInvoices()
  const idx = invoices.findIndex((i) => i.id === invoice.id)

  const now = nowIso()
  const base = idx >= 0 ? invoices[idx] : null
  const next: SalesInvoice = {
    ...(base ?? invoice),
    ...invoice,
    createdAt: base?.createdAt ?? invoice.createdAt ?? now,
    updatedAt: now,
    sentAt: base?.sentAt ?? invoice.sentAt ?? null,
  }

  const out = [...invoices]
  if (idx >= 0) out[idx] = next
  else out.unshift(next)
  writeList(KEYS.invoices, out)
  return next
}

export function getInvoice(id: string): SalesInvoice | null {
  return listInvoices().find((i) => i.id === id) ?? null
}

export function createInvoice(input: Omit<SalesInvoice, 'id' | 'invoiceNumber' | 'createdAt' | 'updatedAt' | 'sentAt'>): SalesInvoice {
  assertBrowser()
  const id = globalThis.crypto?.randomUUID?.() ?? `invoice-${Date.now()}`
  const invoiceNumber = `INV-${nextNumber('invoice')}`
  const now = nowIso()
  const invoice: SalesInvoice = {
    ...input,
    id,
    invoiceNumber,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    remindersEnabled: (input as any)?.remindersEnabled !== false,
  }

  const next = [invoice, ...listInvoices()]
  writeList(KEYS.invoices, next)
  return invoice
}

export function updateInvoice(id: string, patch: Partial<SalesInvoice>): SalesInvoice {
  assertBrowser()
  const invoices = listInvoices()
  const idx = invoices.findIndex((i) => i.id === id)
  if (idx < 0) throw new Error('Invoice not found')

  const next: SalesInvoice = { ...invoices[idx], ...patch, updatedAt: nowIso() }
  const out = [...invoices]
  out[idx] = next
  writeList(KEYS.invoices, out)
  return next
}

export function deleteInvoice(id: string): void {
  assertBrowser()
  writeList(KEYS.invoices, listInvoices().filter((i) => i.id !== id))
  // Leave payments untouched (they might be reconciled later)
}

export function listPayments(): SalesPayment[] {
  return readList<SalesPayment>(KEYS.payments)
}

export function upsertPayment(payment: SalesPayment): SalesPayment {
  assertBrowser()
  const payments = listPayments()
  const idx = payments.findIndex((p) => p.id === payment.id)

  const base = idx >= 0 ? payments[idx] : null
  const next: SalesPayment = {
    ...(base ?? payment),
    ...payment,
    createdAt: base?.createdAt ?? payment.createdAt ?? nowIso(),
  }

  const out = [...payments]
  if (idx >= 0) out[idx] = next
  else out.unshift(next)
  writeList(KEYS.payments, out)
  return next
}

export function createPayment(input: Omit<SalesPayment, 'id' | 'createdAt'>): SalesPayment {
  assertBrowser()
  const id = globalThis.crypto?.randomUUID?.() ?? `payment-${Date.now()}`
  const payment: SalesPayment = {
    ...input,
    id,
    createdAt: nowIso(),
  }

  const next = [payment, ...listPayments()]
  writeList(KEYS.payments, next)
  return payment
}

export function deletePayment(id: string): void {
  assertBrowser()
  writeList(KEYS.payments, listPayments().filter((p) => p.id !== id))
}

export function getSalesSettings(): SalesSettings {
  const defaults: SalesSettings = {
    businessName: '',
    address: '',
    abn: '',
    phone: '',
    email: '',
    website: '',
    taxRatePercent: 10,
    defaultQuoteValidDays: 14,
    defaultInvoiceDueDays: 7,
    defaultTerms: 'Payment due within 7 days unless otherwise agreed.',
    paymentDetails: '',
    updatedAt: nowIso(),
  }

  if (isBrowser()) {
    const existing = safeJsonParse<Partial<SalesSettings> | null>(localStorage.getItem(KEYS.settings), null)
    if (existing) {
      const merged: SalesSettings = { ...defaults, ...existing }
      return merged
    }
  }

  if (isBrowser()) {
    localStorage.setItem(KEYS.settings, JSON.stringify(defaults))
  }
  return defaults
}

export function saveSalesSettings(patch: Partial<SalesSettings>): SalesSettings {
  assertBrowser()
  const current = getSalesSettings()

  const parsedTaxRatePercent = Number(patch.taxRatePercent)
  const parsedDefaultQuoteValidDays = Number((patch as any).defaultQuoteValidDays)
  const parsedDefaultInvoiceDueDays = Number((patch as any).defaultInvoiceDueDays)

  const next: SalesSettings = {
    ...current,
    ...patch,
    taxRatePercent: Number.isFinite(parsedTaxRatePercent) ? parsedTaxRatePercent : current.taxRatePercent,
    defaultQuoteValidDays:
      Number.isFinite(parsedDefaultQuoteValidDays) && parsedDefaultQuoteValidDays >= 0
        ? parsedDefaultQuoteValidDays
        : current.defaultQuoteValidDays,
    defaultInvoiceDueDays:
      Number.isFinite(parsedDefaultInvoiceDueDays) && parsedDefaultInvoiceDueDays >= 0
        ? parsedDefaultInvoiceDueDays
        : current.defaultInvoiceDueDays,
    updatedAt: nowIso(),
  }
  localStorage.setItem(KEYS.settings, JSON.stringify(next))
  emitSalesNativeStoreChanged()
  return next
}

export function getTodayYmd(): string {
  return todayYmd()
}
