import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  invoiceId: z.string().trim().min(1),
})

// POST /api/admin/accounting/transactions/[id]/match-invoice
// Matches a bank deposit to an open invoice by creating a SalesPayment and linking it.
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
  if (!parsed.success) return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })

  const invoice = await prisma.salesInvoice.findUnique({ where: { id: parsed.data.invoiceId } })
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  if (!['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID'].includes(invoice.status)) {
    return NextResponse.json({ error: `Invoice status is ${invoice.status} — only open invoices can be matched` }, { status: 409 })
  }

  // Find the first active INCOME-type account to link as the revenue account
  const incomeAccount = await prisma.account.findFirst({
    where: { type: 'INCOME', isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: { id: true },
  })

  const updated = await prisma.$transaction(async (tx) => {
    // Create a payment record for the full bank transaction amount
    const payment = await tx.salesPayment.create({
      data: {
        source: 'MANUAL',
        paymentDate: txn.date,
        amountCents: txn.amountCents,
        method: 'Bank Transfer',
        reference: txn.description ?? '',
        clientId: invoice.clientId,
        invoiceId: invoice.id,
      } as any,
    })

    // Recompute invoice status (may flip to PAID / PARTIALLY_PAID)
    await recomputeInvoiceStoredStatus(tx as any, invoice.id, { createdByUserId: authResult.id })

    // Match the bank transaction to the payment
    const updatedTxn = await tx.bankTransaction.update({
      where: { id },
      data: {
        status: 'MATCHED',
        matchType: 'INVOICE_PAYMENT',
        invoicePaymentId: payment.id,
        transactionType: 'ReceivePayment',
        accountId: incomeAccount?.id ?? null,
      },
      include: {
        bankAccount: { select: { id: true, name: true } },
        expense: { include: { account: true } },
        account: true,
        invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true, invoice: { select: { invoiceNumber: true, clientId: true, client: { select: { name: true } } } } } },
      },
    })

    return updatedTxn
  })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
