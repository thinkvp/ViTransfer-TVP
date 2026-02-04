import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { salesInvoiceFromDb, salesPaymentFromDb, salesQuoteFromDb } from '@/lib/sales/db-mappers'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { invoiceEffectiveStatus, quoteEffectiveStatus } from '@/lib/sales/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_INVOICES = 2000
const MAX_QUOTES = 2000
const MAX_PAYMENTS = 5000
const MAX_STRIPE_PAYMENTS = 500

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function parseCommaIds(raw: string | null): string[] {
  if (!raw) return []
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ).slice(0, 200)
}

type RollupPaymentRow = {
  id: string
  source: 'LOCAL' | 'STRIPE'
  paymentDate: string // YYYY-MM-DD
  amountCents: number
  method: string | null
  reference: string | null
  clientId: string | null
  invoiceId: string | null
  excludeFromInvoiceBalance?: boolean
  createdAt: string
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-rollup-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const clientId = url.searchParams.get('clientId')?.trim() || null
  const projectId = url.searchParams.get('projectId')?.trim() || null

  const invoiceIds = parseCommaIds(url.searchParams.get('invoiceIds'))

  const invoicesLimit = clampInt(url.searchParams.get('invoicesLimit'), 500, 1, MAX_INVOICES)
  const quotesLimit = clampInt(url.searchParams.get('quotesLimit'), 500, 1, MAX_QUOTES)
  const paymentsLimit = clampInt(url.searchParams.get('paymentsLimit'), 500, 1, MAX_PAYMENTS)
  const stripePaymentsLimit = clampInt(url.searchParams.get('stripePaymentsLimit'), 200, 1, MAX_STRIPE_PAYMENTS)

  const includeQuotes = url.searchParams.get('includeQuotes') !== 'false'
  const includeInvoices = url.searchParams.get('includeInvoices') !== 'false'
  const includePayments = url.searchParams.get('includePayments') !== 'false'

  const nowMs = Date.now()

  const settingsRow = await prisma.salesSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
    select: { taxRatePercent: true },
  })
  const taxRatePercent = Number.isFinite(Number(settingsRow?.taxRatePercent)) ? Number(settingsRow.taxRatePercent) : 10

  const [invoiceRows, quoteRows] = await Promise.all([
    includeInvoices
      ? prisma.salesInvoice.findMany({
          where: {
            ...(clientId ? { clientId } : {}),
            ...(projectId ? { projectId } : {}),
            ...(invoiceIds.length ? { id: { in: invoiceIds } } : {}),
          },
          orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
          take: invoicesLimit,
        })
      : Promise.resolve([] as any[]),
    includeQuotes
      ? prisma.salesQuote.findMany({
          where: {
            ...(clientId ? { clientId } : {}),
            ...(projectId ? { projectId } : {}),
          },
          orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
          take: quotesLimit,
        })
      : Promise.resolve([] as any[]),
  ])

  const invoices = invoiceRows.map((r) => salesInvoiceFromDb(r as any))
  const quotes = quoteRows.map((r) => salesQuoteFromDb(r as any))

  const invoiceIdList = invoices.map((i) => i.id)

  const paymentInvoiceConstraint = invoiceIds.length ? invoiceIds : projectId ? invoiceIdList : null
  const paymentRows = includePayments
    ? await prisma.salesPayment.findMany({
        where: {
          ...(clientId ? { clientId } : {}),
          ...(paymentInvoiceConstraint && paymentInvoiceConstraint.length ? { invoiceId: { in: paymentInvoiceConstraint } } : {}),
        },
        orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
        take: paymentsLimit,
      })
    : ([] as any[])

  const localPayments = paymentRows.map((r) => salesPaymentFromDb(r as any))

  const allowUnscopedStripePayments = !clientId && !projectId && invoiceIds.length === 0
  const stripeInvoiceIds = invoiceIds.length ? invoiceIds : invoiceIdList
  const shouldQueryStripePayments = includePayments && (allowUnscopedStripePayments || stripeInvoiceIds.length > 0)

  const [stripePaymentsRaw, localAgg, stripeAgg] = await Promise.all([
    shouldQueryStripePayments
      ? prisma.salesInvoiceStripePayment.findMany({
          where: stripeInvoiceIds.length ? { invoiceDocId: { in: stripeInvoiceIds } } : undefined,
          orderBy: { createdAt: 'desc' },
          take: stripePaymentsLimit,
          select: {
            id: true,
            invoiceDocId: true,
            invoiceNumber: true,
            invoiceAmountCents: true,
            stripePaymentIntentId: true,
            stripeCheckoutSessionId: true,
            stripeChargeId: true,
            createdAt: true,
          },
        })
      : Promise.resolve([] as any[]),
    // Local payment totals per invoice (balance/status)
    invoiceIdList.length
      ? prisma.salesPayment.groupBy({
          by: ['invoiceId'],
          where: { invoiceId: { in: invoiceIdList }, excludeFromInvoiceBalance: false },
          _sum: { amountCents: true },
          _max: { paymentDate: true },
        })
      : Promise.resolve([] as any[]),
    // Stripe totals per invoice (balance/status)
    invoiceIdList.length
      ? prisma.salesInvoiceStripePayment.groupBy({
          by: ['invoiceDocId'],
          where: { invoiceDocId: { in: invoiceIdList } },
          _sum: { invoiceAmountCents: true },
          _max: { createdAt: true },
        })
      : Promise.resolve([] as any[]),
  ])

  const paidLocalByInvoiceId: Record<string, { paidCents: number; latestYmd: string | null }> = {}
  for (const g of localAgg as any[]) {
    const id = String(g?.invoiceId ?? '').trim()
    if (!id) continue
    const paid = Number(g?._sum?.amountCents ?? 0)
    const latest = typeof g?._max?.paymentDate === 'string' ? g._max.paymentDate : null
    paidLocalByInvoiceId[id] = {
      paidCents: Number.isFinite(paid) ? Math.max(0, Math.trunc(paid)) : 0,
      latestYmd: latest && /^\d{4}-\d{2}-\d{2}$/.test(latest) ? latest : null,
    }
  }

  const paidStripeByInvoiceId: Record<string, { paidCents: number; latestYmd: string | null }> = {}
  for (const g of stripeAgg as any[]) {
    const id = String(g?.invoiceDocId ?? '').trim()
    if (!id) continue
    const paid = Number(g?._sum?.invoiceAmountCents ?? 0)
    const latest: unknown = g?._max?.createdAt
    const latestYmd = latest instanceof Date
      ? latest.toISOString().slice(0, 10)
      : (typeof latest === 'string' && /^\d{4}-\d{2}-\d{2}/.test(latest) ? latest.slice(0, 10) : null)

    paidStripeByInvoiceId[id] = {
      paidCents: Number.isFinite(paid) ? Math.max(0, Math.trunc(paid)) : 0,
      latestYmd,
    }
  }

  const invoiceRollupById: Record<
    string,
    {
      totalCents: number
      paidLocalCents: number
      paidStripeCents: number
      paidCents: number
      balanceCents: number
      effectiveStatus: string
      latestPaymentYmd: string | null
    }
  > = {}

  for (const inv of invoices) {
    const subtotal = sumLineItemsSubtotal(inv.items)
    const tax = sumLineItemsTax(inv.items, taxRatePercent)
    const total = subtotal + tax

    const local = paidLocalByInvoiceId[inv.id]?.paidCents ?? 0
    const stripe = paidStripeByInvoiceId[inv.id]?.paidCents ?? 0
    const paid = local + stripe
    const balance = Math.max(0, total - paid)

    const effective = invoiceEffectiveStatus(
      {
        status: inv.status,
        sentAt: inv.sentAt,
        dueDate: inv.dueDate,
        totalCents: total,
        paidCents: paid,
      },
      nowMs
    )

    const latestYmd = [paidLocalByInvoiceId[inv.id]?.latestYmd ?? null, paidStripeByInvoiceId[inv.id]?.latestYmd ?? null]
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      .sort()
      .at(-1)
      ?? null

    invoiceRollupById[inv.id] = {
      totalCents: total,
      paidLocalCents: local,
      paidStripeCents: stripe,
      paidCents: paid,
      balanceCents: balance,
      effectiveStatus: effective,
      latestPaymentYmd: latestYmd,
    }
  }

  const quoteEffectiveStatusById: Record<string, string> = {}
  for (const q of quotes) {
    quoteEffectiveStatusById[q.id] = quoteEffectiveStatus({ status: q.status, validUntil: q.validUntil }, nowMs)
  }

  const invoiceById = Object.fromEntries(invoices.map((i) => [i.id, i]))

  const stripePayments: RollupPaymentRow[] = (stripePaymentsRaw as any[]).map((p) => {
    const invoiceDocId = typeof p?.invoiceDocId === 'string' ? p.invoiceDocId : null
    const createdAtIso = p?.createdAt instanceof Date ? p.createdAt.toISOString() : String(p?.createdAt ?? '')
    const ymd = /^\d{4}-\d{2}-\d{2}/.test(createdAtIso) ? createdAtIso.slice(0, 10) : new Date().toISOString().slice(0, 10)

    const amountRaw = Number(p?.invoiceAmountCents)
    const amountCents = Number.isFinite(amountRaw) ? Math.max(0, Math.trunc(amountRaw)) : 0

    const inv = invoiceDocId ? invoiceById[invoiceDocId] : null
    const client = inv?.clientId ?? null

    const ref =
      (typeof p?.stripeChargeId === 'string' && p.stripeChargeId.trim())
        ? p.stripeChargeId.trim()
        : (typeof p?.stripePaymentIntentId === 'string' && p.stripePaymentIntentId.trim())
          ? p.stripePaymentIntentId.trim()
          : (typeof p?.stripeCheckoutSessionId === 'string' && p.stripeCheckoutSessionId.trim())
            ? p.stripeCheckoutSessionId.trim()
            : (typeof p?.invoiceNumber === 'string' && p.invoiceNumber.trim())
              ? `Stripe payment for ${p.invoiceNumber.trim()}`
              : 'Stripe payment'

    return {
      id: `stripe-payment-${String(p?.id ?? '')}`,
      source: 'STRIPE',
      paymentDate: ymd,
      amountCents,
      method: 'Stripe',
      reference: ref,
      clientId: client,
      invoiceId: invoiceDocId,
      createdAt: createdAtIso,
    }
  })

  const unifiedPayments: RollupPaymentRow[] = [
    ...localPayments.map((p) => ({
      id: p.id,
      source: 'LOCAL' as const,
      paymentDate: p.paymentDate,
      amountCents: p.amountCents,
      method: p.method || null,
      reference: p.reference || null,
      clientId: p.clientId ?? null,
      invoiceId: p.invoiceId ?? null,
      excludeFromInvoiceBalance: Boolean((p as any).excludeFromInvoiceBalance),
      createdAt: p.createdAt,
    })),
    ...stripePayments,
  ]

  unifiedPayments.sort((a, b) => String(b.paymentDate).localeCompare(String(a.paymentDate)))

  const stats = (() => {
    const openQuotes = quotes.filter((q) => {
      const st = quoteEffectiveStatusById[q.id]
      return st === 'OPEN' || st === 'SENT'
    }).length

    const openQuoteDrafts = quotes.filter((q) => quoteEffectiveStatusById[q.id] === 'OPEN').length

    const invoiceRollups = Object.values(invoiceRollupById)
    const openInvoices = invoiceRollups.filter((r) => r.effectiveStatus !== 'PAID')
    const overdueInvoices = invoiceRollups.filter((r) => r.effectiveStatus === 'OVERDUE')
    const openBalanceCents = openInvoices.reduce((acc, r) => acc + r.balanceCents, 0)

    return {
      openQuotes,
      openQuoteDrafts,
      openInvoices: openInvoices.length,
      overdueInvoices: overdueInvoices.length,
      openBalanceCents,
    }
  })()

  const res = NextResponse.json({
    taxRatePercent,
    invoices,
    quotes,
    payments: unifiedPayments,
    invoiceRollupById,
    quoteEffectiveStatusById,
    stats,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
