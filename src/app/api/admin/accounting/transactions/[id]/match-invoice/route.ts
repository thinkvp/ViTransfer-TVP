import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { getAccountingSettings } from '@/lib/accounting/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  // Array of invoice IDs — one or more invoices to match against the deposit.
  // A single ID replicates the previous single-invoice behaviour.
  invoiceIds: z.string().trim().min(1).array().min(1),
  // When true (single-invoice only), the invoice may already be PAID (via Stripe) and the
  // bank deposit is being reconciled against it. The resulting SalesPayment will have
  // excludeFromInvoiceBalance=true so it does not double-count revenue.
  reconcile: z.boolean().optional(),
})

// POST /api/admin/accounting/transactions/[id]/match-invoice
// Matches a bank deposit to one or more open invoices by creating SalesPayment records.
// Single invoice: creates one payment for the full bank transaction amount.
// Multiple invoices: creates one payment per invoice at its outstanding balance;
//   the sum must match the bank transaction amount (within $1.00 rounding tolerance).
// When reconcile=true (single invoice only), also accepts PAID invoices (Stripe-paid).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' },
    'admin-accounting-match-invoice',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params

  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: { bankAccount: { select: { id: true, name: true } } },
  })

  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.status === 'MATCHED') return NextResponse.json({ error: 'Transaction is already matched' }, { status: 409 })
  if (txn.amountCents <= 0) return NextResponse.json({ error: 'Only deposits (positive transactions) can be matched to invoices' }, { status: 400 })

  const body = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0]?.message || 'invoiceIds is required' }, { status: 400 })

  const { invoiceIds, reconcile } = parsed.data
  const isMultiInvoice = invoiceIds.length > 1

  if (reconcile && isMultiInvoice) {
    return NextResponse.json({ error: 'Reconcile mode is only supported for a single invoice' }, { status: 400 })
  }

  // Look up all specified invoices in one query
  const invoices = await prisma.salesInvoice.findMany({
    where: { id: { in: invoiceIds } },
  })

  if (invoices.length !== invoiceIds.length) {
    const foundIds = new Set(invoices.map(i => i.id))
    const missing = invoiceIds.filter(i => !foundIds.has(i))
    return NextResponse.json({ error: `Invoice not found: ${missing[0]}` }, { status: 404 })
  }

  // Validate invoice statuses
  for (const invoice of invoices) {
    if (reconcile) {
      if (invoice.status !== 'PAID') {
        return NextResponse.json({ error: `Invoice ${invoice.invoiceNumber} status is ${invoice.status} — reconcile mode only applies to fully paid invoices` }, { status: 409 })
      }
    } else {
      if (!['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID'].includes(invoice.status)) {
        return NextResponse.json({ error: `Invoice ${invoice.invoiceNumber} status is ${invoice.status} — only open invoices can be matched` }, { status: 409 })
      }
    }
  }

  // For single non-reconcile invoice: check it's not already fully paid
  if (!isMultiInvoice && !reconcile) {
    const invoice = invoices[0]
    const invoiceBalance = await recomputeInvoiceStoredStatus(prisma, invoice.id, { createdByUserId: authResult.id })
    if (invoiceBalance && invoiceBalance.totalCents > 0 && invoiceBalance.paidCents >= invoiceBalance.totalCents) {
      return NextResponse.json({ error: 'Invoice is already fully paid' }, { status: 409 })
    }
  }

  // For reconcile mode (single invoice): detect rounding difference and auto-split
  let roundingCents = 0
  let stripeRoundingAccountId: string | null = null
  if (reconcile && !isMultiInvoice) {
    const invoice = invoices[0]
    const salesSettingsRow = await prisma.salesSettings.findUnique({
      where: { id: 'default' },
      select: { taxRatePercent: true },
    }).catch(() => null)
    const defaultTaxRate = Number.isFinite(Number(salesSettingsRow?.taxRatePercent))
      ? Number(salesSettingsRow!.taxRatePercent)
      : 10

    const items = Array.isArray((invoice as any).itemsJson) ? (invoice as any).itemsJson : []
    const subtotalCents = sumLineItemsSubtotal(items)
    const taxCents = (invoice as any).taxEnabled ? sumLineItemsTax(items, defaultTaxRate) : 0
    const invoiceTotalCents = subtotalCents + taxCents

    const diff = txn.amountCents - invoiceTotalCents
    if (diff !== 0 && Math.abs(diff) <= 100) {
      const accountingSettings = await getAccountingSettings()
      if (accountingSettings.stripeRoundingAccountId) {
        roundingCents = diff
        stripeRoundingAccountId = accountingSettings.stripeRoundingAccountId
      }
    }
  }

  // For multi-invoice: pre-compute each invoice's outstanding balance and validate sum
  const salesSettings = isMultiInvoice
    ? await prisma.salesSettings.findUnique({ where: { id: 'default' }, select: { taxRatePercent: true } }).catch(() => null)
    : null
  const multiTaxRate = Number.isFinite(Number(salesSettings?.taxRatePercent)) ? Number(salesSettings!.taxRatePercent) : 10

  const invoiceAllocations: { invoiceId: string; clientId: string | null; amountCents: number }[] = []

  if (isMultiInvoice) {
    for (const invoice of invoices) {
      // Compute invoice total from line items
      const items = Array.isArray((invoice as any).itemsJson) ? (invoice as any).itemsJson : []
      const subtotalCents = sumLineItemsSubtotal(items)
      const taxCents = (invoice as any).taxEnabled ? sumLineItemsTax(items, multiTaxRate) : 0
      const totalCents = subtotalCents + taxCents

      // Compute already-paid amount (exclude invoiceBalance=false payments + Stripe payments)
      const [manualPaid, stripePaid] = await Promise.all([
        prisma.salesPayment.aggregate({
          where: { invoiceId: invoice.id, excludeFromInvoiceBalance: false },
          _sum: { amountCents: true },
        }),
        prisma.salesInvoiceStripePayment.aggregate({
          where: { invoiceDocId: invoice.id },
          _sum: { invoiceAmountCents: true },
        }),
      ])
      const paidCents = (manualPaid._sum.amountCents ?? 0) + (Number(stripePaid._sum.invoiceAmountCents) || 0)
      const outstandingCents = Math.max(0, totalCents - paidCents)

      if (outstandingCents === 0) {
        return NextResponse.json({ error: `Invoice ${invoice.invoiceNumber} is already fully paid` }, { status: 409 })
      }

      invoiceAllocations.push({ invoiceId: invoice.id, clientId: invoice.clientId, amountCents: outstandingCents })
    }

    const totalAllocated = invoiceAllocations.reduce((s, a) => s + a.amountCents, 0)
    const remainder = txn.amountCents - totalAllocated
    if (Math.abs(remainder) > 100) {
      return NextResponse.json({
        error: `Selected invoices total ${(totalAllocated / 100).toFixed(2)} but bank deposit is ${(txn.amountCents / 100).toFixed(2)} — difference must be $1.00 or less`,
      }, { status: 422 })
    }
    // If there's a small rounding difference on multi-invoice, absorb it into the first invoice's payment
    if (remainder !== 0) {
      invoiceAllocations[0].amountCents += remainder
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const reference = reconcile
      ? `Bank reconciliation: ${txn.description ?? ''}`.trimEnd()
      : (txn.description ?? '')

    if (isMultiInvoice) {
      // Create one SalesPayment per invoice at its outstanding balance
      for (const alloc of invoiceAllocations) {
        await tx.salesPayment.create({
          data: {
            source: 'MANUAL',
            paymentDate: txn.date,
            amountCents: alloc.amountCents,
            method: 'Bank Transfer',
            reference,
            clientId: alloc.clientId,
            invoiceId: alloc.invoiceId,
            bankTransactionId: id,
          } as any,
        })
        await recomputeInvoiceStoredStatus(tx, alloc.invoiceId, { createdByUserId: authResult.id })
      }

      // Match the bank transaction (no primary invoicePaymentId for multi-invoice)
      return tx.bankTransaction.update({
        where: { id },
        data: {
          status: 'MATCHED',
          matchType: 'INVOICE_PAYMENT',
          invoicePaymentId: null,
          transactionType: 'ReceivePayment',
          accountId: null,
          taxCode: null,
        },
        include: {
          bankAccount: { select: { id: true, name: true } },
          expense: { include: { account: true } },
          account: true,
          invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true, invoice: { select: { invoiceNumber: true, clientId: true, client: { select: { name: true } } } } } },
          invoicePayments: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true, invoice: { select: { invoiceNumber: true, clientId: true, client: { select: { name: true } } } } } },
        },
      })
    }

    // Single invoice path
    const invoice = invoices[0]
    const paymentAmountCents = (reconcile && stripeRoundingAccountId && roundingCents !== 0)
      ? txn.amountCents - roundingCents
      : txn.amountCents

    const payment = await tx.salesPayment.create({
      data: {
        source: 'MANUAL',
        paymentDate: txn.date,
        amountCents: paymentAmountCents,
        method: 'Bank Transfer',
        reference,
        clientId: invoice.clientId,
        invoiceId: invoice.id,
        bankTransactionId: id,
        ...(reconcile ? { excludeFromInvoiceBalance: true } : {}),
      } as any,
    })

    // Post rounding difference as a split line (reconcile mode only)
    if (reconcile && stripeRoundingAccountId && roundingCents !== 0) {
      await tx.splitLine.create({
        data: {
          bankTransactionId: id,
          accountId: stripeRoundingAccountId,
          description: 'Stripe bank deposit rounding',
          amountCents: roundingCents,
          taxCode: 'BAS_EXCLUDED',
        },
      })
    }

    if (!reconcile) {
      await recomputeInvoiceStoredStatus(tx, invoice.id, { createdByUserId: authResult.id })
    }

    return tx.bankTransaction.update({
      where: { id },
      data: {
        status: 'MATCHED',
        matchType: 'INVOICE_PAYMENT',
        invoicePaymentId: payment.id,
        transactionType: 'ReceivePayment',
        accountId: null,
        taxCode: null,
      },
      include: {
        bankAccount: { select: { id: true, name: true } },
        expense: { include: { account: true } },
        account: true,
        invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true, invoice: { select: { invoiceNumber: true, clientId: true, client: { select: { name: true } } } } } },
        invoicePayments: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true, invoice: { select: { invoiceNumber: true, clientId: true, client: { select: { name: true } } } } } },
      },
    })
  })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
