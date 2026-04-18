import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { basPeriodFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const paymentSchema = z.object({
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // GST net component (1A − 1B) — must be positive
  gstAmountCents: z.number().int().min(1),
  // PAYG Income Tax Instalment component (T7) — 0 if none
  paygAmountCents: z.number().int().min(0).default(0),
  // Account for the GST net (e.g. GST Payable liability)
  gstAccountId: z.string().trim().min(1),
  // Account for the PAYG instalment (required when paygAmountCents > 0)
  paygAccountId: z.string().trim().min(1).optional().nullable(),
  paymentNotes: z.string().trim().max(2000).optional().nullable(),
})

// POST /api/admin/accounting/bas/[id]/payment
// Stores payment date, amounts, and target accounts on the BAS period.
// No Expense records are created — reconciliation happens when the ATO bank debit
// is matched as BAS_PAYMENT against this period.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many requests.' },
    'admin-accounting-bas-payment',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const period = await prisma.basPeriod.findUnique({ where: { id } })

  if (!period) return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  if (period.status !== 'LODGED') return NextResponse.json({ error: 'Only lodged BAS periods can have a payment recorded' }, { status: 409 })
  if (period.paymentDate) return NextResponse.json({ error: 'A payment has already been recorded for this period' }, { status: 409 })

  const body = await request.json().catch(() => null)
  const parsed = paymentSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const { paymentDate, gstAmountCents, paygAmountCents, gstAccountId, paygAccountId, paymentNotes } = parsed.data

  if (paygAmountCents > 0 && !paygAccountId) {
    return NextResponse.json({ error: 'A PAYG account is required when a PAYG amount is entered' }, { status: 400 })
  }

  const gstAccount = await prisma.account.findUnique({ where: { id: gstAccountId } })
  if (!gstAccount) return NextResponse.json({ error: 'GST account not found' }, { status: 404 })
  if (!gstAccount.isActive) return NextResponse.json({ error: 'GST account is inactive' }, { status: 400 })

  if (paygAmountCents > 0 && paygAccountId) {
    const paygAccount = await prisma.account.findUnique({ where: { id: paygAccountId } })
    if (!paygAccount) return NextResponse.json({ error: 'PAYG account not found' }, { status: 404 })
    if (!paygAccount.isActive) return NextResponse.json({ error: 'PAYG account is inactive' }, { status: 400 })
  }

  const updated = await prisma.basPeriod.update({
    where: { id },
    data: {
      paymentDate,
      paymentAmountCents: gstAmountCents + paygAmountCents,
      paymentNotes: paymentNotes ?? null,
      paymentGstCents: gstAmountCents,
      paymentGstAccountId: gstAccountId,
      paymentPaygCents: paygAmountCents > 0 ? paygAmountCents : null,
      paymentPaygAccountId: paygAmountCents > 0 ? (paygAccountId ?? null) : null,
    },
    include: { accountingAttachments: true },
  })

  const res = NextResponse.json({ period: basPeriodFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// DELETE /api/admin/accounting/bas/[id]/payment
// Clears the recorded payment from the BAS period.
// If a bank transaction has been matched as BAS_PAYMENT, unmatches it first.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 30, message: 'Too many requests.' },
    'admin-accounting-bas-payment-delete',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params
  const period = await prisma.basPeriod.findUnique({ where: { id } })

  if (!period) return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  if (!period.paymentDate) return NextResponse.json({ error: 'No payment recorded for this period' }, { status: 404 })

  const linkedBankTxn = await (prisma.bankTransaction as any).findFirst({
    where: { basPeriodId: id },
    select: { id: true },
  })

  const updated = await prisma.$transaction(async (tx) => {
    // If a bank transaction was matched as BAS_PAYMENT against this period, unmatch it
    if (linkedBankTxn) {
      await tx.splitLine.deleteMany({ where: { bankTransactionId: linkedBankTxn.id } })
      await tx.bankTransaction.update({
        where: { id: linkedBankTxn.id },
        data: { status: 'UNMATCHED', matchType: null, basPeriodId: null, transactionType: null },
      })
    }

    return tx.basPeriod.update({
      where: { id },
      data: {
        paymentDate: null,
        paymentAmountCents: null,
        paymentNotes: null,
        paymentGstCents: null,
        paymentGstAccountId: null,
        paymentPaygCents: null,
        paymentPaygAccountId: null,
      },
      include: { accountingAttachments: true },
    })
  })

  const res = NextResponse.json({ period: basPeriodFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}


