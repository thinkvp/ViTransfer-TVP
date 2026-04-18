import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const matchBasSchema = z.object({
  basPeriodId: z.string().trim().min(1),
})

// POST /api/admin/accounting/transactions/[id]/match-bas
// Matches a bank debit to a lodged BAS period that has payment details recorded.
// Creates split lines from the saved GST and PAYG components and marks the transaction
// as MATCHED with matchType=BAS_PAYMENT.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
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
  if (txn.amountCents >= 0) return NextResponse.json({ error: 'BAS Payment match is only valid for debits (negative amounts)' }, { status: 400 })

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

  if (!gstCents || !period.paymentGstAccountId) {
    return NextResponse.json({ error: 'BAS period payment details are incomplete — GST amount or account missing' }, { status: 409 })
  }

  // The bank debit amount must equal the total payment (sign-insensitive comparison)
  if (Math.abs(txn.amountCents) !== totalCents) {
    return NextResponse.json({
      error: `Transaction amount ${Math.abs(txn.amountCents)} cents does not match BAS payment total ${totalCents} cents`,
    }, { status: 409 })
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Create split lines — amounts are negative (debit/money out)
    await tx.splitLine.create({
      data: {
        bankTransactionId: id,
        accountId: period.paymentGstAccountId!,
        description: `BAS — GST net — ${period.label || `Q${period.quarter} ${period.financialYear}`}`,
        amountCents: -gstCents,
        taxCode: 'BAS_EXCLUDED',
      },
    })

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
        transactionType: 'Expense',
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
