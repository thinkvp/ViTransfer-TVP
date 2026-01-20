import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireMenuAccess } from '@/lib/rbac-api'
import type { SalesLineItem } from '@/lib/sales/types'
import { sumLineItemsTotal } from '@/lib/sales/money'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function monthKeyFromDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function parseMonthKey(month: string): { year: number; monthIndex: number } | null {
  const m = String(month || '').trim()
  const match = /^([0-9]{4})-([0-9]{2})$/.exec(m)
  if (!match) return null
  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return null
  if (monthIndex < 0 || monthIndex > 11) return null
  return { year, monthIndex }
}

function ymd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseLineItems(itemsJson: unknown): SalesLineItem[] {
  if (!Array.isArray(itemsJson)) return []
  return itemsJson.map((raw, idx) => {
    const it: any = raw ?? {}
    const quantity = Number(it.quantity)
    const unitPriceCents = Number(it.unitPriceCents)
    const taxRatePercent = Number(it.taxRatePercent)

    return {
      id: typeof it.id === 'string' ? it.id : `li-${idx}`,
      description: typeof it.description === 'string' ? it.description : '',
      details: typeof it.details === 'string' ? it.details : undefined,
      quantity: Number.isFinite(quantity) ? quantity : 0,
      unitPriceCents: Number.isFinite(unitPriceCents) ? unitPriceCents : 0,
      taxRatePercent: Number.isFinite(taxRatePercent) ? taxRatePercent : NaN,
    }
  })
}

// GET /api/admin/sales/calendar?month=YYYY-MM - sales calendar items (internal)
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'sales')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-calendar'
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const monthParam = url.searchParams.get('month')
  const monthInfo = monthParam ? parseMonthKey(monthParam) : null

  const base = monthInfo
    ? new Date(monthInfo.year, monthInfo.monthIndex, 1)
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1)

  const monthKey = monthKeyFromDate(base)
  const start = new Date(base.getFullYear(), base.getMonth(), 1)
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 0)

  const startYmd = ymd(start)
  const endYmd = ymd(end)

  const settings = await prisma.salesSettings.findUnique({
    where: { id: 'default' },
    select: { taxRatePercent: true },
  })
  const defaultTaxRatePercent = Number(settings?.taxRatePercent)
  const taxRatePercent = Number.isFinite(defaultTaxRatePercent) ? defaultTaxRatePercent : 0

  const [quotes, invoices] = await Promise.all([
    prisma.salesQuote.findMany({
      where: {
        validUntil: { not: null, gte: startYmd, lte: endYmd },
        status: { notIn: ['ACCEPTED', 'CLOSED'] },
      },
      select: {
        id: true,
        quoteNumber: true,
        status: true,
        validUntil: true,
        client: { select: { name: true } },
        project: { select: { id: true, title: true } },
      },
      orderBy: [{ validUntil: 'asc' }, { quoteNumber: 'asc' }],
    }),
    prisma.salesInvoice.findMany({
      where: {
        dueDate: { not: null, gte: startYmd, lte: endYmd },
        status: { not: 'PAID' },
      },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        dueDate: true,
        itemsJson: true,
        payments: { select: { amountCents: true } },
        client: { select: { name: true } },
        project: { select: { id: true, title: true } },
      },
      orderBy: [{ dueDate: 'asc' }, { invoiceNumber: 'asc' }],
    }),
  ])

  const invoiceIds = invoices.map((inv) => inv.id)
  const stripePayments = invoiceIds.length
    ? await prisma.salesInvoiceStripePayment.findMany({
        where: { invoiceDocId: { in: invoiceIds } },
        select: { invoiceDocId: true, invoiceAmountCents: true },
      })
    : []

  const stripePaidByInvoiceId = stripePayments.reduce<Record<string, number>>((acc, p) => {
    const id = typeof p.invoiceDocId === 'string' ? p.invoiceDocId : ''
    const cents = Number(p.invoiceAmountCents)
    if (!id || !Number.isFinite(cents) || cents <= 0) return acc
    acc[id] = (acc[id] ?? 0) + cents
    return acc
  }, {})

  const visibleInvoices = invoices.filter((inv) => {
    if (inv.status === 'PAID') return false

    const items = parseLineItems((inv as any).itemsJson)
    const totalCents = sumLineItemsTotal(items, taxRatePercent)
    if (!(Number.isFinite(totalCents) && totalCents > 0)) return true

    const manualPaidCents = Array.isArray((inv as any).payments)
      ? (inv as any).payments.reduce((acc: number, p: any) => {
          const cents = Number(p?.amountCents)
          return Number.isFinite(cents) ? acc + cents : acc
        }, 0)
      : 0

    const stripePaidCents = stripePaidByInvoiceId[inv.id] ?? 0
    const paidCents = manualPaidCents + stripePaidCents

    return paidCents < totalCents
  })

  const items = [
    ...quotes
      .filter((q) => Boolean(q.validUntil))
      .map((q) => ({
        kind: 'sales' as const,
        docType: 'quote' as const,
        docId: q.id,
        docNumber: q.quoteNumber,
        status: q.status,
        date: q.validUntil as string,
        clientName: q.client?.name ?? null,
        projectId: q.project?.id ?? null,
        projectTitle: q.project?.title ?? null,
      })),
    ...visibleInvoices
      .filter((inv) => Boolean(inv.dueDate))
      .map((inv) => ({
        kind: 'sales' as const,
        docType: 'invoice' as const,
        docId: inv.id,
        docNumber: inv.invoiceNumber,
        status: inv.status,
        date: inv.dueDate as string,
        clientName: inv.client?.name ?? null,
        projectId: inv.project?.id ?? null,
        projectTitle: inv.project?.title ?? null,
      })),
  ].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date)
    if (a.docType !== b.docType) return a.docType.localeCompare(b.docType)
    return a.docNumber.localeCompare(b.docNumber)
  })

  const response = NextResponse.json({ month: monthKey, start: startYmd, end: endYmd, items })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}
