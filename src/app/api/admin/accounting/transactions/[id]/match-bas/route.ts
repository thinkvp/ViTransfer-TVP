import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenuAction } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const matchBasSchema = z.object({
  basPeriodId: z.string().trim().min(1),
})

// POST /api/admin/accounting/transactions/[id]/match-bas
// Matches a bank debit (payment) or credit (refund) to a lodged BAS period that has
// payment details recorded. The period's amounts are signed (negative = refund), so the
// bank amount must be their exact negation. Creates split lines from the saved GST and
// PAYG components and marks the transaction as MATCHED with matchType=BAS_PAYMENT.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' },
    'admin-accounting-transaction-match-bas',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params

  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: { splitLines: true },
  })
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.status === 'MATCHED') return NextResponse.json({ error: 'Transaction is already matched' }, { status: 409 })
  if (txn.amountCents === 0) return NextResponse.json({ error: 'BAS Payment match is not valid for a zero-amount transaction' }, { status: 400 })

  const body = await request.json().catch(() => null)
  const parsed = matchBasSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const period = await prisma.basPeriod.findUnique({
    where: { id: parsed.data.basPeriodId },
    include: { bankTransaction: { select: { id: true } } },
  })
  if (!period) return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  if (period.status !== 'LODGED') return NextResponse.json({ error: 'BAS period is not lodged' }, { status: 409 })
  if (!period.paymentDate) return NextResponse.json({ error: 'Record the payment details on the BAS period first' }, { status: 409 })
  if ((period as any).bankTransaction) return NextResponse.json({ error: 'This BAS period is already linked to a bank transaction' }, { status: 409 })

  const gstCents = period.paymentGstCents
  const paygCents = period.paymentPaygCents ?? 0
  const totalCents = (gstCents ?? 0) + paygCents
  const isRefund = totalCents < 0

  if (gstCents == null || !period.paymentGstAccountId) {
    return NextResponse.json({ error: 'BAS period payment details are incomplete — GST amount or account missing' }, { status: 409 })
  }

  // A payment (+) is a bank debit (−); a refund (−) is a bank credit (+)
  if (txn.amountCents !== -totalCents) {
    return NextResponse.json({
      error: isRefund
        ? `This BAS period expects a refund deposit of ${-totalCents} cents; the transaction is ${txn.amountCents} cents`
        : `This BAS period expects a payment debit of ${totalCents} cents; the transaction is ${txn.amountCents} cents`,
    }, { status: 409 })
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Split line amounts follow the bank sign: negative for money out, positive for a refund in
    if (gstCents !== 0) {
      await tx.splitLine.create({
        data: {
          bankTransactionId: id,
          accountId: period.paymentGstAccountId!,
          description: `BAS — GST net${gstCents < 0 ? ' refund' : ''} — ${period.label || `Q${period.quarter} ${period.financialYear}`}`,
          amountCents: -gstCents,
          taxCode: 'BAS_EXCLUDED',
        },
      })
    }

    if (paygCents > 0 && period.paymentPaygAccountId) {
      await tx.splitLine.create({
        data: {
          bankTransactionId: id,
          accountId: period.paymentPaygAccountId,
          description: `BAS — PAYG Instalment — ${period.label || `Q${period.quarter} ${period.financialYear}`}`,
          amountCents: -paygCents,
          taxCode: 'BAS_EXCLUDED',
        },
      })
    }

    // Mark the bank transaction as matched
    await tx.bankTransaction.update({
      where: { id },
      data: {
        status: 'MATCHED',
        matchType: 'BAS_PAYMENT',
        transactionType: isRefund ? 'Deposit' : 'Expense',
        basPeriodId: period.id,
      },
    })

    return tx.bankTransaction.findUnique({
      where: { id },
      include: {
        bankAccount: { select: { id: true, name: true } },
        expense: { include: { account: true } },
        account: true,
        invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true } },
        splitLines: { include: { account: true } },
        basPeriod: { select: { id: true, label: true, quarter: true, financialYear: true } },
      },
    })
  })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated!) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
