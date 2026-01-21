import { prisma } from '@/lib/db'
import { salesInvoiceFromDb, salesQuoteFromDb, salesSettingsFromDb } from '@/lib/sales/db-mappers'
import type { SalesLineItem, SalesSettings } from '@/lib/sales/types'

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

function coerceNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s ? s : null
}

async function getSalesSettings(tx: typeof prisma): Promise<SalesSettings> {
  const row = await (tx as any).salesSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  })
  return salesSettingsFromDb(row as any)
}

export async function mergeQboQuotesIntoSalesTables(nativeQuotes: any[]): Promise<{ ingested: number; skippedMissingClient: number; updatedAt: string }> {
  const updatedAt = nowIso()
  let ingested = 0
  let skippedMissingClient = 0

  await prisma.$transaction(async (tx) => {
    const settings = await getSalesSettings(tx as any)

    for (const q of Array.isArray(nativeQuotes) ? nativeQuotes : []) {
      const qboId = typeof q?.qboId === 'string' ? q.qboId : ''
      if (!qboId) continue

      const clientId = typeof q?.clientId === 'string' && q.clientId ? q.clientId : null
      if (!clientId) {
        skippedMissingClient += 1
        continue
      }

      const issueDate = parseYmd(q?.txnDate) ?? todayYmd()
      const validUntil = parseYmd(q?.validUntil) ?? addDaysYmd(issueDate, (settings as any).defaultQuoteValidDays ?? 14)

      const rawDocNumber = typeof q?.docNumber === 'string' && q.docNumber.trim() ? q.docNumber.trim() : `QBO-EST-${qboId}`
      const docNumber = ensurePrefix(rawDocNumber, 'EST-')

      const itemsJson = buildLineItems(q?.lines, { idPrefix: `qbo-${qboId}`, taxRatePercent: (settings as any).taxRatePercent })
      const terms = coerceNonEmptyString(q?.customerMemo) ?? (settings as any).defaultTerms

      const existing = await (tx as any).salesQuote.findUnique({ where: { qboId } })
      if (!existing) {
        const created = await (tx as any).salesQuote.create({
          data: {
            quoteNumber: docNumber,
            status: 'OPEN',
            acceptedFromStatus: null,
            clientId,
            projectId: null,
            issueDate,
            validUntil: validUntil || null,
            notes: typeof q?.privateNote === 'string' ? q.privateNote : '',
            terms,
            itemsJson,
            sentAt: null,
            remindersEnabled: true,
            lastExpiryReminderSentYmd: null,
            qboId,
            version: 1,
          },
        })

        await (tx as any).salesQuoteRevision.create({
          data: {
            quoteId: created.id,
            version: created.version,
            docJson: salesQuoteFromDb(created as any),
            createdByUserId: null,
          },
        })

        ingested += 1
        continue
      }

      continue
    }
  })

  return { ingested, skippedMissingClient, updatedAt }
}

export async function mergeQboInvoicesIntoSalesTables(nativeInvoices: any[]): Promise<{ ingested: number; skippedMissingClient: number; updatedAt: string }> {
  const updatedAt = nowIso()
  let ingested = 0
  let skippedMissingClient = 0

  await prisma.$transaction(async (tx) => {
    const settings = await getSalesSettings(tx as any)

    for (const inv of Array.isArray(nativeInvoices) ? nativeInvoices : []) {
      const qboId = typeof inv?.qboId === 'string' ? inv.qboId : ''
      if (!qboId) continue

      const clientId = typeof inv?.clientId === 'string' && inv.clientId ? inv.clientId : null
      if (!clientId) {
        skippedMissingClient += 1
        continue
      }

      const issueDate = parseYmd(inv?.txnDate) ?? todayYmd()
      const dueDate = parseYmd(inv?.dueDate) ?? addDaysYmd(issueDate, (settings as any).defaultInvoiceDueDays ?? 7)

      const rawDocNumber = typeof inv?.docNumber === 'string' && inv.docNumber.trim() ? inv.docNumber.trim() : `QBO-INV-${qboId}`
      const docNumber = ensurePrefix(rawDocNumber, 'INV-')

      const itemsJson = buildLineItems(inv?.lines, { idPrefix: `qbo-inv-${qboId}`, taxRatePercent: (settings as any).taxRatePercent })
      const terms = coerceNonEmptyString(inv?.customerMemo) ?? (settings as any).defaultTerms

      const existing = await (tx as any).salesInvoice.findUnique({ where: { qboId } })
      if (!existing) {
        const created = await (tx as any).salesInvoice.create({
          data: {
            invoiceNumber: docNumber,
            status: 'OPEN',
            clientId,
            projectId: null,
            issueDate,
            dueDate: dueDate || null,
            notes: typeof inv?.privateNote === 'string' ? inv.privateNote : '',
            terms,
            itemsJson,
            sentAt: null,
            remindersEnabled: true,
            lastOverdueReminderSentYmd: null,
            qboId,
            version: 1,
          },
        })

        await (tx as any).salesInvoiceRevision.create({
          data: {
            invoiceId: created.id,
            version: created.version,
            docJson: salesInvoiceFromDb(created as any),
            createdByUserId: null,
          },
        })

        ingested += 1
        continue
      }

      continue
    }
  })

  return { ingested, skippedMissingClient, updatedAt }
}

export async function mergeQboPaymentsIntoSalesTables(nativePayments: Array<{
  paymentQboId: string
  invoiceQboId: string
  txnDate: string | null
  amountCents: number
  method: string
  reference: string
  clientId: string | null
}>): Promise<{ ingested: number; skippedMissingInvoice: number; skippedMissingAmount: number; updatedAt: string }> {
  const updatedAt = nowIso()
  let ingested = 0
  let skippedMissingInvoice = 0
  let skippedMissingAmount = 0

  await prisma.$transaction(async (tx) => {
    const invoiceQboIds = Array.from(
      new Set(
        (Array.isArray(nativePayments) ? nativePayments : [])
          .map((p) => (typeof p?.invoiceQboId === 'string' ? p.invoiceQboId.trim() : ''))
          .filter(Boolean)
      )
    )

    const invoices = invoiceQboIds.length
      ? await (tx as any).salesInvoice.findMany({
          where: { qboId: { in: invoiceQboIds } },
          select: { id: true, qboId: true, clientId: true },
        })
      : []

    const invoiceByQboId = new Map<string, { id: string; clientId: string }>(
      invoices
        .map((r: any) => {
          const qboId = typeof r?.qboId === 'string' ? r.qboId : null
          if (!qboId) return null
          return [qboId, { id: String(r.id), clientId: String(r.clientId) }] as const
        })
        .filter(Boolean) as any
    )

    for (const p of Array.isArray(nativePayments) ? nativePayments : []) {
      const paymentQboId = typeof p?.paymentQboId === 'string' ? p.paymentQboId.trim() : ''
      const invoiceQboId = typeof p?.invoiceQboId === 'string' ? p.invoiceQboId.trim() : ''
      if (!paymentQboId || !invoiceQboId) continue

      const inv = invoiceByQboId.get(invoiceQboId) ?? null
      if (!inv) {
        skippedMissingInvoice += 1
        continue
      }

      const amountCents = Number(p?.amountCents)
      if (!Number.isFinite(amountCents)) {
        skippedMissingAmount += 1
        continue
      }

      const qboId = `${paymentQboId}-inv-${invoiceQboId}`

      const paymentDate = parseYmd(p?.txnDate) ?? todayYmd()
      const method = typeof p?.method === 'string' ? p.method : 'QuickBooks'
      const reference = typeof p?.reference === 'string' ? p.reference : `QBO-PAY-${paymentQboId}`
      const clientId = typeof p?.clientId === 'string' && p.clientId ? p.clientId : inv.clientId

      const existing = await (tx as any).salesPayment.findUnique({ where: { qboId }, select: { id: true } })
      if (existing) {
        continue
      }

      const data = {
        source: 'QUICKBOOKS',
        paymentDate,
        amountCents: Math.max(0, Math.trunc(amountCents)),
        method,
        reference,
        clientId,
        invoiceId: inv.id,
        qboId,
      }

      await (tx as any).salesPayment.create({ data })
      ingested += 1
    }
  })

  return { ingested, skippedMissingInvoice, skippedMissingAmount, updatedAt }
}
