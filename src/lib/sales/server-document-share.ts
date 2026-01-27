import crypto from 'crypto'

import { prisma } from '@/lib/db'
import { salesSettingsFromDb } from '@/lib/sales/db-mappers'
import type { SalesInvoice, SalesQuote, SalesSettings } from '@/lib/sales/types'

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function parseYmdLocal(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const yyyy = Number(m[1])
  const mm = Number(m[2])
  const dd = Number(m[3])
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null
  const d = new Date(yyyy, mm - 1, dd)
  return Number.isFinite(d.getTime()) ? d : null
}

function endOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

function addDaysLocal(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

function computeExpiresAt(input: {
  type: 'QUOTE' | 'INVOICE'
  quoteValidUntilYmd?: string | null
  invoicePaidAtYmd?: string | null
}): Date | null {
  if (input.type === 'QUOTE') {
    const until = parseYmdLocal(input.quoteValidUntilYmd)
    if (!until) return null
    return addDaysLocal(endOfDayLocal(until), 30)
  }

  const paidAt = parseYmdLocal(input.invoicePaidAtYmd)
  if (!paidAt) return null
  return addDaysLocal(endOfDayLocal(paidAt), 30)
}

async function getSalesSettingsJson(tx: typeof prisma): Promise<SalesSettings> {
  const row = await (tx as any).salesSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  })
  return salesSettingsFromDb(row as any)
}

export async function upsertSalesDocumentShareForDoc(tx: typeof prisma, input: {
  type: 'QUOTE' | 'INVOICE'
  doc: SalesQuote | SalesInvoice
  clientId: string
  projectId?: string | null
  quoteValidUntilYmd?: string | null
  invoicePaidAtYmd?: string | null
}): Promise<{ token: string } | null> {
  const docId = String((input.doc as any)?.id || '')
  if (!docId) return null

  const docNumber = input.type === 'QUOTE'
    ? String((input.doc as any)?.quoteNumber || '')
    : String((input.doc as any)?.invoiceNumber || '')
  if (!docNumber.trim()) return null

  const settingsJson = await getSalesSettingsJson(tx)

  const client = await (tx as any).client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: { name: true, address: true },
  }).catch(() => null)

  const project = input.projectId
    ? await (tx as any).project.findFirst({ where: { id: input.projectId }, select: { title: true } }).catch(() => null)
    : null

  const clientAddress = typeof client?.address === 'string' && client.address.trim() ? client.address.trim() : null
  const docSnapshot = clientAddress
    ? { ...(input.doc as any), clientAddress }
    : input.doc

  const expiresAt = computeExpiresAt({
    type: input.type,
    quoteValidUntilYmd: input.quoteValidUntilYmd ?? null,
    invoicePaidAtYmd: input.invoicePaidAtYmd ?? null,
  })

  const existing = await (tx as any).salesDocumentShare.findUnique({
    where: { type_docId: { type: input.type, docId } },
    select: { token: true, revokedAt: true },
  }).catch(() => null)

  let token = existing?.token
  if (!token || existing?.revokedAt) token = randomToken()

  const record = await (tx as any).salesDocumentShare.upsert({
    where: { type_docId: { type: input.type, docId } },
    create: {
      token,
      type: input.type,
      docId,
      docNumber,
      docJson: docSnapshot as any,
      settingsJson: settingsJson as any,
      clientName: typeof client?.name === 'string' ? client.name : null,
      projectTitle: typeof project?.title === 'string' ? project.title : null,
      expiresAt,
    },
    update: {
      token,
      docNumber,
      docJson: docSnapshot as any,
      settingsJson: settingsJson as any,
      clientName: typeof client?.name === 'string' ? client.name : null,
      projectTitle: typeof project?.title === 'string' ? project.title : null,
      expiresAt,
      revokedAt: null,
    },
    select: { token: true },
  })

  return record?.token ? { token: String(record.token) } : null
}
