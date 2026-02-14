import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { SalesInvoice, SalesLineItem, SalesPayment, SalesQuote, SalesSettings } from '@/lib/sales/types'
import type { SalesNativeStoreData } from '@/lib/sales/native-store-types'

function nowIso(): string {
  return new Date().toISOString()
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseYmd(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return s
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00`)
  if (!Number.isFinite(d.getTime())) return ymd
  d.setDate(d.getDate() + (Number.isFinite(days) ? days : 0))
  return d.toISOString().slice(0, 10)
}

function ensurePrefix(value: string, prefix: string): string {
  const v = value.trim()
  if (!v) return prefix
  const upper = v.toUpperCase()
  if (upper.startsWith(prefix.toUpperCase())) return v
  return `${prefix}${v}`
}

function normalizeSettings(input: unknown): SalesSettings {
  const defaults: SalesSettings = {
    businessName: '',
    address: '',
    abn: '',
    phone: '',
    email: '',
    website: '',
    businessRegistrationLabel: 'ABN',
    currencySymbol: '$',
    currencyCode: 'AUD',
    taxRatePercent: 10,
    defaultQuoteValidDays: 14,
    defaultInvoiceDueDays: 7,
    defaultTerms: 'Payment due within 7 days unless otherwise agreed.',
    paymentDetails: '',
    quoteLabel: 'QUOTE',
    invoiceLabel: 'INVOICE',
    taxLabel: '',
    taxEnabled: true,
    updatedAt: nowIso(),
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults
  const patch = input as Partial<SalesSettings>

  const parsedTaxRatePercent = Number(patch.taxRatePercent)
  const parsedDefaultQuoteValidDays = Number((patch as any).defaultQuoteValidDays)
  const parsedDefaultInvoiceDueDays = Number((patch as any).defaultInvoiceDueDays)

  return {
    ...defaults,
    ...patch,
    taxRatePercent: Number.isFinite(parsedTaxRatePercent) ? parsedTaxRatePercent : defaults.taxRatePercent,
    defaultQuoteValidDays:
      Number.isFinite(parsedDefaultQuoteValidDays) && parsedDefaultQuoteValidDays >= 0
        ? parsedDefaultQuoteValidDays
        : defaults.defaultQuoteValidDays,
    defaultInvoiceDueDays:
      Number.isFinite(parsedDefaultInvoiceDueDays) && parsedDefaultInvoiceDueDays >= 0
        ? parsedDefaultInvoiceDueDays
        : defaults.defaultInvoiceDueDays,
    updatedAt: typeof patch.updatedAt === 'string' && patch.updatedAt ? patch.updatedAt : defaults.updatedAt,
  }
}

function defaultStoreData(): SalesNativeStoreData {
  return {
    quotes: [],
    invoices: [],
    payments: [],
    settings: normalizeSettings(null),
    seq: { quote: 0, invoice: 0 },
  }
}

function normalizeStoreData(input: unknown): SalesNativeStoreData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaultStoreData()
  const obj = input as any
  return {
    quotes: Array.isArray(obj.quotes) ? (obj.quotes as SalesQuote[]) : [],
    invoices: Array.isArray(obj.invoices) ? (obj.invoices as SalesInvoice[]) : [],
    payments: Array.isArray(obj.payments) ? (obj.payments as SalesPayment[]) : [],
    settings: normalizeSettings(obj.settings),
    seq: {
      quote: Number.isFinite(Number(obj?.seq?.quote)) ? Math.max(0, Math.trunc(Number(obj.seq.quote))) : 0,
      invoice: Number.isFinite(Number(obj?.seq?.invoice)) ? Math.max(0, Math.trunc(Number(obj.seq.invoice))) : 0,
    },
  }
}

async function getOrCreateDefaultStoreRow() {
  return (prisma as any).salesNativeStore.upsert({
    where: { id: 'default' },
    create: { id: 'default', data: defaultStoreData() as unknown as Prisma.InputJsonValue },
    update: {},
    select: { data: true, updatedAt: true },
  })
}

async function saveDefaultStoreData(data: SalesNativeStoreData): Promise<{ updatedAt: string }> {
  const jsonData = data as unknown as Prisma.InputJsonValue
  const updated = await (prisma as any).salesNativeStore.upsert({
    where: { id: 'default' },
    create: { id: 'default', data: jsonData },
    update: { data: jsonData },
    select: { updatedAt: true },
  })
  return { updatedAt: updated.updatedAt.toISOString() }
}

function stableLineItemId(prefix: string, index: number): string {
  return `${prefix}-li-${index + 1}`
}

function buildLineItems(input: unknown, opts: { idPrefix: string; taxRatePercent: number }): SalesLineItem[] {
  const lines = Array.isArray(input) ? input : []
  return lines.map((ln: any, idx: number) => ({
    id: stableLineItemId(opts.idPrefix, idx),
    description: String(ln?.description || '').trim() || 'Line item',
    quantity: Number.isFinite(Number(ln?.quantity)) && Number(ln?.quantity) > 0 ? Number(ln.quantity) : 1,
    unitPriceCents: Number.isFinite(Number(ln?.unitPriceCents)) ? Math.round(Number(ln.unitPriceCents)) : 0,
    taxRatePercent: opts.taxRatePercent,
  }))
}

function upsertById<T extends { id: string }>(list: T[], next: T): T[] {
  const idx = list.findIndex((x) => x.id === next.id)
  if (idx < 0) return [next, ...list]
  const out = [...list]
  out[idx] = next
  return out
}

export async function mergeQboQuotesIntoSalesNativeStore(nativeQuotes: any[]): Promise<{ ingested: number; skippedMissingClient: number; updatedAt: string }> {
  const row = await getOrCreateDefaultStoreRow()
  const store = normalizeStoreData(row.data)
  const settings = store.settings

  let ingested = 0
  let skippedMissingClient = 0

  for (const q of Array.isArray(nativeQuotes) ? nativeQuotes : []) {
    const qboId = typeof q?.qboId === 'string' ? q.qboId : ''
    if (!qboId) continue

    const clientId = typeof q?.clientId === 'string' && q.clientId ? q.clientId : null
    if (!clientId) {
      skippedMissingClient += 1
      continue
    }

    const issueDate = parseYmd(q?.txnDate) ?? todayYmd()
    const validUntil = parseYmd(q?.validUntil) ?? addDaysYmd(issueDate, settings.defaultQuoteValidDays ?? 14)

    const rawDocNumber = typeof q?.docNumber === 'string' && q.docNumber.trim() ? q.docNumber.trim() : `QBO-EST-${qboId}`
    const docNumber = ensurePrefix(rawDocNumber, 'EST-')

    const id = `qbo-estimate-${qboId}`
    const base = store.quotes.find((x) => x.id === id) ?? null

    const now = nowIso()
    const next: SalesQuote = {
      ...(base ?? ({} as SalesQuote)),
      id,
      quoteNumber: docNumber,
      status: base?.status ?? 'OPEN',
      acceptedFromStatus: base?.acceptedFromStatus ?? null,
      clientId,
      projectId: base?.projectId ?? null,
      issueDate,
      validUntil: validUntil || null,
      notes: typeof q?.privateNote === 'string' ? q.privateNote : (base?.notes ?? ''),
      terms: settings.defaultTerms,
      items: buildLineItems(q?.lines, { idPrefix: `qbo-${qboId}`, taxRatePercent: settings.taxRatePercent }),
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
      sentAt: base?.sentAt ?? null,
    }

    store.quotes = upsertById(store.quotes, next)
    ingested += 1
  }

  // Touch settings.updatedAt to ensure there is always a string.
  store.settings = normalizeSettings(store.settings)

  const saved = await saveDefaultStoreData(store)
  return { ingested, skippedMissingClient, updatedAt: saved.updatedAt }
}

export async function mergeQboInvoicesIntoSalesNativeStore(nativeInvoices: any[]): Promise<{ ingested: number; skippedMissingClient: number; updatedAt: string }> {
  const row = await getOrCreateDefaultStoreRow()
  const store = normalizeStoreData(row.data)
  const settings = store.settings

  let ingested = 0
  let skippedMissingClient = 0

  for (const inv of Array.isArray(nativeInvoices) ? nativeInvoices : []) {
    const qboId = typeof inv?.qboId === 'string' ? inv.qboId : ''
    if (!qboId) continue

    const clientId = typeof inv?.clientId === 'string' && inv.clientId ? inv.clientId : null
    if (!clientId) {
      skippedMissingClient += 1
      continue
    }

    const issueDate = parseYmd(inv?.txnDate) ?? todayYmd()
    const dueDate = parseYmd(inv?.dueDate) ?? addDaysYmd(issueDate, settings.defaultInvoiceDueDays ?? 7)

    const rawDocNumber = typeof inv?.docNumber === 'string' && inv.docNumber.trim() ? inv.docNumber.trim() : `QBO-INV-${qboId}`
    const docNumber = ensurePrefix(rawDocNumber, 'INV-')

    const id = `qbo-invoice-${qboId}`
    const base = store.invoices.find((x) => x.id === id) ?? null

    const now = nowIso()
    const next: SalesInvoice = {
      ...(base ?? ({} as SalesInvoice)),
      id,
      invoiceNumber: docNumber,
      status: base?.status ?? 'OPEN',
      clientId,
      projectId: base?.projectId ?? null,
      issueDate,
      dueDate: dueDate || null,
      notes: typeof inv?.privateNote === 'string' ? inv.privateNote : (base?.notes ?? ''),
      terms: settings.defaultTerms,
      items: buildLineItems(inv?.lines, { idPrefix: `qbo-inv-${qboId}`, taxRatePercent: settings.taxRatePercent }),
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
      sentAt: base?.sentAt ?? null,
    }

    store.invoices = upsertById(store.invoices, next)
    ingested += 1
  }

  store.settings = normalizeSettings(store.settings)

  const saved = await saveDefaultStoreData(store)
  return { ingested, skippedMissingClient, updatedAt: saved.updatedAt }
}

export async function mergeQboPaymentsIntoSalesNativeStore(nativePayments: any[]): Promise<{ ingested: number; skippedMissingInvoice: number; skippedMissingAmount: number; updatedAt: string }> {
  const row = await getOrCreateDefaultStoreRow()
  const store = normalizeStoreData(row.data)

  const invoiceIds = new Set(store.invoices.map((i) => i.id))

  let ingested = 0
  let skippedMissingInvoice = 0
  let skippedMissingAmount = 0

  for (const p of Array.isArray(nativePayments) ? nativePayments : []) {
    const paymentQboId = typeof p?.paymentQboId === 'string' ? p.paymentQboId : ''
    const invoiceQboId = typeof p?.invoiceQboId === 'string' ? p.invoiceQboId : ''
    if (!paymentQboId || !invoiceQboId) continue

    const invoiceId = `qbo-invoice-${invoiceQboId}`
    if (!invoiceIds.has(invoiceId)) {
      skippedMissingInvoice += 1
      continue
    }

    const amountCents = Number.isFinite(Number(p?.amountCents)) ? Math.round(Number(p.amountCents)) : NaN
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      skippedMissingAmount += 1
      continue
    }

    const paymentDate = parseYmd(p?.txnDate) ?? todayYmd()
    const method = typeof p?.method === 'string' && p.method.trim() ? p.method.trim() : 'QuickBooks'
    const reference = typeof p?.reference === 'string' && p.reference.trim() ? p.reference.trim() : `QBO-PAY-${paymentQboId}`
    const clientId = typeof p?.clientId === 'string' ? p.clientId : null

    const id = `qbo-payment-${paymentQboId}-inv-${invoiceQboId}`
    const base = store.payments.find((x) => x.id === id) ?? null

    const next: SalesPayment = {
      ...(base ?? ({} as SalesPayment)),
      id,
      paymentDate,
      amountCents,
      method,
      reference,
      clientId,
      invoiceId,
      createdAt: base?.createdAt ?? nowIso(),
    }

    store.payments = upsertById(store.payments, next)
    ingested += 1
  }

  const saved = await saveDefaultStoreData(store)
  return { ingested, skippedMissingInvoice, skippedMissingAmount, updatedAt: saved.updatedAt }
}

export function generateServerSideToken(): string {
  // Exported only for parity/testing if needed later.
  return crypto.randomUUID()
}
