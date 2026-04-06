import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { expenseFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  supplierName: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().min(1).max(5000).optional(),
  accountId: z.string().trim().min(1).optional(),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']).optional(),
  amountIncGst: z.number().positive().describe('Amount including GST in dollars').optional(),
  notes: z.string().trim().max(5000).optional().nullable(),
  status: z.enum(['DRAFT', 'APPROVED', 'RECONCILED']).optional(),
  receiptPath: z.string().trim().max(500).optional().nullable(),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-expense-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const expense = await prisma.expense.findUnique({
    where: { id },
    include: { account: true, user: { select: { id: true, name: true, email: true } } },
  })

  if (!expense) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }

  const res = NextResponse.json({ expense: expenseFromDb(expense) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-expense-put',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.expense.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data

  if (data.accountId) {
    const account = await prisma.account.findUnique({ where: { id: data.accountId } })
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }
    if (!['EXPENSE', 'COGS'].includes(account.type)) {
      return NextResponse.json({ error: 'Account must be of type EXPENSE or COGS' }, { status: 400 })
    }
  }

  const updated = await prisma.expense.update({
    where: { id },
    data: {
      ...(data.date !== undefined ? { date: data.date } : {}),
      ...(data.supplierName !== undefined ? { supplierName: data.supplierName ?? null } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.accountId !== undefined ? { accountId: data.accountId } : {}),
      ...(data.taxCode !== undefined ? { taxCode: data.taxCode } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.receiptPath !== undefined ? { receiptPath: data.receiptPath } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      // Recalculate cents if amount or taxCode changed
      ...((data.amountIncGst !== undefined || data.taxCode !== undefined) ? await (async () => {
        const resolvedTaxCode = data.taxCode ?? existing.taxCode
        const amountIncGstCents = data.amountIncGst !== undefined ? Math.round(data.amountIncGst * 100) : existing.amountIncGst
        let gstAmountCents = 0
        if (resolvedTaxCode === 'GST') {
          const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' }, select: { taxRatePercent: true } })
          const taxRate = (settings?.taxRatePercent ?? 10) / 100
          gstAmountCents = Math.round(amountIncGstCents * taxRate / (1 + taxRate))
        }
        const amountExGstCents = amountIncGstCents - gstAmountCents
        return { amountIncGst: amountIncGstCents, gstAmount: gstAmountCents, amountExGst: amountExGstCents }
      })() : {}),
    },
    include: { account: true, user: { select: { id: true, name: true, email: true } } },
  })

  const res = NextResponse.json({ expense: expenseFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-expense-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.expense.findUnique({
    where: { id },
    select: { id: true, bankTransactionId: true },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }

  if (existing.bankTransactionId) {
    return NextResponse.json(
      { error: 'Cannot delete expense — it is matched to a bank transaction. Unmatch it first.' },
      { status: 409 }
    )
  }

  await prisma.expense.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
