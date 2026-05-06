import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/accounting/open-invoices
// Returns lightweight invoice data for the invoice-matching dialog in Bank Accounts.
// Falls back to any open/sent/overdue/partially-paid invoices.
// Pass includeStripeReconcile=true to also return PAID invoices that were settled via Stripe,
// marked with stripeReconcilable=true so the UI can offer a bank-deposit reconciliation flow.
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-open-invoices',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const search = searchParams.get('q')?.trim()
  const includeStripeReconcile = searchParams.get('includeStripeReconcile') === 'true'

  // Fetch the default tax rate once so we can compute invoice totals for filtering.
  const settingsRow = await prisma.salesSettings.findUnique({
    where: { id: 'default' },
    select: { taxRatePercent: true },
  }).catch(() => null)
  const defaultTaxRate = Number.isFinite(Number(settingsRow?.taxRatePercent))
    ? Number(settingsRow!.taxRatePercent)
    : 10

  // Heal step: find PAID invoices with no remaining payment balance and recompute their
  // stored status. This silently fixes invoices that became stuck as PAID after a payment
  // was deleted before the auto-recompute fix was in place. Capped at 10 per call so it
  // never meaningfully delays the response.
  try {
    const stuckInvoices = await prisma.salesInvoice.findMany({
      where: { status: 'PAID' },
      select: {
        id: true,
        _count: { select: { payments: true } },
      },
      take: 10,
    })
    const orphaned = stuckInvoices.filter((inv: any) => inv._count.payments === 0)
    for (const inv of orphaned) {
      await recomputeInvoiceStoredStatus(prisma as any, inv.id, { createdByUserId: authResult.id })
    }
  } catch {
    // Best-effort only — never fail the main query over this
  }

  const rows = await prisma.salesInvoice.findMany({
    where: {
      status: { in: ['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID'] },
      ...(search
        ? {
            OR: [
              { invoiceNumber: { contains: search, mode: 'insensitive' } },
              { client: { name: { contains: search, mode: 'insensitive' } } },
              { project: { title: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      client: { select: { id: true, name: true } },
      project: { select: { id: true, title: true } },
      payments: { where: { excludeFromInvoiceBalance: false }, select: { amountCents: true } },
    },
    orderBy: [{ issueDate: 'desc' }],
    take: 50,
  })

  const invoiceIds = rows.map((row: any) => row.id)
  const stripePayments = invoiceIds.length
    ? await prisma.salesInvoiceStripePayment.findMany({
        where: { invoiceDocId: { in: invoiceIds } },
        select: { invoiceDocId: true, invoiceAmountCents: true },
      })
    : []

  const stripePaidByInvoiceId = stripePayments.reduce<Record<string, number>>((acc, payment) => {
    const invoiceId = typeof payment.invoiceDocId === 'string' ? payment.invoiceDocId : ''
    const cents = Number(payment.invoiceAmountCents)
    if (!invoiceId || !Number.isFinite(cents) || cents <= 0) return acc
    acc[invoiceId] = (acc[invoiceId] ?? 0) + cents
    return acc
  }, {})

  const invoices = rows
    .map((r: any) => {
      const items = Array.isArray(r.itemsJson) ? r.itemsJson : []
      const subtotalCents = sumLineItemsSubtotal(items as any)
      const taxCents = r.taxEnabled ? sumLineItemsTax(items as any, defaultTaxRate) : 0
      const totalCents = subtotalCents + taxCents
      const manualPaidCents = (r.payments as Array<{ amountCents: number }>).reduce((sum, p) => sum + (p.amountCents ?? 0), 0)
      const stripePaidCents = stripePaidByInvoiceId[r.id] ?? 0
      const totalPaidCents = manualPaidCents + stripePaidCents
      const outstandingBalanceCents = Math.max(0, totalCents - totalPaidCents)

      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        status: r.status,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        clientName: r.client?.name ?? null,
        projectTitle: r.project?.title ?? null,
        totalCents,
        totalPaidCents,
        outstandingBalanceCents,
        stripeReconcilable: false as boolean,
      }
    })
    .filter((inv) => inv.outstandingBalanceCents > 0)

  // Optionally include PAID invoices that were settled via Stripe, so the user can reconcile
  // a bank deposit against them without double-counting revenue.
  let stripeReconcilableInvoices: typeof invoices = []
  if (includeStripeReconcile) {
    const searchFilter = search
      ? {
          OR: [
            { invoiceNumber: { contains: search, mode: 'insensitive' as const } },
            { client: { name: { contains: search, mode: 'insensitive' as const } } },
            { project: { title: { contains: search, mode: 'insensitive' as const } } },
          ],
        }
      : {}

    // SalesInvoiceStripePayment.invoiceDocId is a plain string field (no Prisma relation on
    // SalesInvoice), so we pre-fetch the distinct IDs of invoices that have stripe payments.
    const stripeInvoiceIdRows = await prisma.salesInvoiceStripePayment.findMany({
      select: { invoiceDocId: true },
      distinct: ['invoiceDocId'],
    })
    const stripeInvoiceIds = stripeInvoiceIdRows
      .map((r) => r.invoiceDocId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)

    if (stripeInvoiceIds.length === 0) {
      // No Stripe payments exist at all — nothing to reconcile
    } else {
    const paidRows = await prisma.salesInvoice.findMany({
      where: {
        status: 'PAID',
        id: { in: stripeInvoiceIds },
        // Exclude invoices that already have a reconciled bank deposit linked
        payments: {
          none: {
            excludeFromInvoiceBalance: true,
            bankTransaction: { isNot: null },
          },
        },
        ...searchFilter,
      },
      include: {
        client: { select: { id: true, name: true } },
        project: { select: { id: true, title: true } },
        payments: { where: { excludeFromInvoiceBalance: false }, select: { amountCents: true } },
      },
      orderBy: [{ issueDate: 'desc' }],
      take: 30,
    })

    const paidInvoiceIds = paidRows.map((r: any) => r.id)
    const paidStripePayments = paidInvoiceIds.length
      ? await prisma.salesInvoiceStripePayment.findMany({
          where: { invoiceDocId: { in: paidInvoiceIds } },
          select: { invoiceDocId: true, invoiceAmountCents: true },
        })
      : []

    const paidStripePaidByInvoiceId = paidStripePayments.reduce<Record<string, number>>((acc, payment) => {
      const invoiceId = typeof payment.invoiceDocId === 'string' ? payment.invoiceDocId : ''
      const cents = Number(payment.invoiceAmountCents)
      if (!invoiceId || !Number.isFinite(cents) || cents <= 0) return acc
      acc[invoiceId] = (acc[invoiceId] ?? 0) + cents
      return acc
    }, {})

    stripeReconcilableInvoices = paidRows.map((r: any) => {
      const items = Array.isArray(r.itemsJson) ? r.itemsJson : []
      const subtotalCents = sumLineItemsSubtotal(items as any)
      const taxCents = r.taxEnabled ? sumLineItemsTax(items as any, defaultTaxRate) : 0
      const totalCents = subtotalCents + taxCents
      const manualPaidCents = (r.payments as Array<{ amountCents: number }>).reduce((sum, p) => sum + (p.amountCents ?? 0), 0)
      const stripePaidCents = paidStripePaidByInvoiceId[r.id] ?? 0
      const totalPaidCents = manualPaidCents + stripePaidCents

      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        status: r.status,
        issueDate: r.issueDate,
        dueDate: r.dueDate ?? null,
        clientName: r.client?.name ?? null,
        projectTitle: r.project?.title ?? null,
        totalCents,
        totalPaidCents,
        outstandingBalanceCents: 0,
        stripeReconcilable: true,
      }
    })
    } // end else (stripeInvoiceIds.length > 0)
  }

  const res = NextResponse.json({ invoices: [...invoices, ...stripeReconcilableInvoices] })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
