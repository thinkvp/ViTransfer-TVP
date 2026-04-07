import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const matchSchema = z.discriminatedUnion('matchType', [
  z.object({
    matchType: z.literal('INVOICE_PAYMENT'),
    invoicePaymentId: z.string().trim().min(1),
  }),
  z.object({
    matchType: z.literal('EXPENSE'),
    expenseId: z.string().trim().min(1),
  }),
  z.object({
    matchType: z.literal('MANUAL'),
    notes: z.string().trim().max(2000).optional().nullable(),
  }),
])

// POST /api/admin/accounting/transactions/[id]/match
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-match',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({ where: { id } })

  if (!txn) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  if (txn.status === 'MATCHED') {
    return NextResponse.json({ error: 'Transaction is already matched' }, { status: 409 })
  }

  const body = await request.json().catch(() => null)
  const parsed = matchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data
  let updateData: Record<string, unknown> = { status: 'MATCHED', matchType: data.matchType }

  if (data.matchType === 'INVOICE_PAYMENT') {
    const payment = await prisma.salesPayment.findUnique({ where: { id: data.invoicePaymentId } })
    if (!payment) {
      return NextResponse.json({ error: 'Invoice payment not found' }, { status: 404 })
    }
    // Check payment isn't already linked to another transaction
    const existingLink = await prisma.bankTransaction.findFirst({
      where: { invoicePaymentId: data.invoicePaymentId, id: { not: id } },
    })
    if (existingLink) {
      return NextResponse.json(
        { error: 'This invoice payment is already matched to another transaction' },
        { status: 409 }
      )
    }
    updateData.invoicePaymentId = data.invoicePaymentId
    updateData.transactionType = 'ReceivePayment'
    updateData.accountId = null
    updateData.taxCode = null
  } else if (data.matchType === 'EXPENSE') {
    const expense = await prisma.expense.findUnique({ where: { id: data.expenseId } })
    if (!expense) {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    }
    if (expense.bankTransactionId && expense.bankTransactionId !== id) {
      return NextResponse.json(
        { error: 'This expense is already matched to another transaction' },
        { status: 409 }
      )
    }
    // Link the expense to this transaction
    await prisma.expense.update({
      where: { id: data.expenseId },
      data: { bankTransactionId: id, status: 'RECONCILED' },
    })
  }

  const updated = await prisma.bankTransaction.update({
    where: { id },
    data: updateData,
    include: {
      bankAccount: { select: { id: true, name: true } },
      expense: { include: { account: true } },
      account: true,
      invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true } },
    },
  })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
