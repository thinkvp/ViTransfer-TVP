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
  paymentAmountCents: z.number().int().positive(),
  paymentNotes: z.string().trim().max(2000).optional().nullable(),
  // Account to debit (e.g. ATO Integrated Client Account, GST Payable, or a general tax expense account)
  accountId: z.string().trim().min(1),
})

// POST /api/admin/accounting/bas/[id]/payment
// Records payment of a lodged BAS — creates an Expense record and stores the payment reference.
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
  if (period.paymentExpenseId) return NextResponse.json({ error: 'A payment has already been recorded for this period' }, { status: 409 })

  const body = await request.json().catch(() => null)
  const parsed = paymentSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const { paymentDate, paymentAmountCents, paymentNotes, accountId } = parsed.data

  const account = await prisma.account.findUnique({ where: { id: accountId } })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  // Allow any account type — BAS payment may go to a liability, expense, or asset account
  if (!account.isActive) return NextResponse.json({ error: 'Account is inactive' }, { status: 400 })

  const description = `BAS payment — ${period.label || `Q${period.quarter} ${period.financialYear}`}`

  const updated = await prisma.$transaction(async (tx) => {
    // Create an expense/payment record BAS_EXCLUDED since this is a tax payment (not a GST transaction)
    const amountCents = paymentAmountCents
    const expense = await tx.expense.create({
      data: {
        date: paymentDate,
        supplierName: 'ATO',
        description,
        accountId,
        taxCode: 'BAS_EXCLUDED',
        amountExGst: amountCents,
        gstAmount: 0,
        amountIncGst: amountCents,
        status: 'APPROVED',
        notes: paymentNotes ?? null,
        userId: authResult.id,
      },
    })

    const updatedPeriod = await tx.basPeriod.update({
      where: { id },
      data: {
        paymentDate,
        paymentAmountCents: amountCents,
        paymentNotes: paymentNotes ?? null,
        paymentExpenseId: expense.id,
      },
    })

    return updatedPeriod
  })

  const res = NextResponse.json({ period: basPeriodFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// DELETE /api/admin/accounting/bas/[id]/payment
// Removes a recorded payment (deletes the linked expense and clears payment fields).
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
  if (!period.paymentExpenseId) return NextResponse.json({ error: 'No payment recorded for this period' }, { status: 404 })

  const updated = await prisma.$transaction(async (tx) => {
    // Clear the reference first so the FK constraint is satisfied before deleting
    const clearedPeriod = await tx.basPeriod.update({
      where: { id },
      data: {
        paymentDate: null,
        paymentAmountCents: null,
        paymentNotes: null,
        paymentExpenseId: null,
      },
    })

    await tx.expense.delete({ where: { id: period.paymentExpenseId! } })

    return clearedPeriod
  })

  const res = NextResponse.json({ period: basPeriodFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
