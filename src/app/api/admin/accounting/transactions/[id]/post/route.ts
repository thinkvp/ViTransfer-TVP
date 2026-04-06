import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TRANSACTION_TYPES = ['Expense', 'Transfer', 'Deposit', 'ReceivePayment'] as const
const TAX_CODES = ['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED'] as const

const postSchema = z.object({
  transactionType: z.enum(TRANSACTION_TYPES),
  accountId: z.string().min(1),
  taxCode: z.enum(TAX_CODES),
  memo: z.string().trim().max(2000).optional().nullable(),
  supplierName: z.string().trim().max(300).optional().nullable(), // for Expense type
})

// POST /api/admin/accounting/transactions/[id]/post
// Posts (reconciles) a bank transaction: for Expense type, creates an Expense record;
// for other types, marks MATCHED with MANUAL match type.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-post',
    authResult.id
  )
  if (rl) return rl

  const { id } = await params

  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { id: true, name: true } },
      expense: { include: { account: true } },
      account: true,
      invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true } },
    },
  })

  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.status === 'MATCHED') return NextResponse.json({ error: 'Transaction is already posted' }, { status: 409 })

  const body = await request.json().catch(() => null)
  const parsed = postSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const d = parsed.data

  // Verify the account exists
  const account = await prisma.account.findUnique({ where: { id: d.accountId }, select: { id: true, name: true } })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 400 })

  const amountIncGst = Math.abs(txn.amountCents)

  // Calculate GST breakdown using configurable rate
  let amountExGst: number
  let gstAmount: number
  if (d.taxCode === 'GST') {
    const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' }, select: { taxRatePercent: true } })
    const taxRate = (settings?.taxRatePercent ?? 10) / 100 // e.g. 0.10
    gstAmount = Math.round(amountIncGst * taxRate / (1 + taxRate))
    amountExGst = amountIncGst - gstAmount
  } else {
    gstAmount = 0
    amountExGst = amountIncGst
  }

  if (d.transactionType === 'Expense') {
    // Create an Expense record linked to this bank transaction
    const supplierName = d.supplierName?.trim() || undefined

    await prisma.$transaction(async (tx) => {
      // If there was a previous linked expense (e.g. re-posting after undo), unlink it
      if (txn.expense) {
        await tx.expense.update({
          where: { id: txn.expense.id },
          data: { bankTransactionId: null, status: 'DRAFT' },
        })
      }

      const newExpense = await tx.expense.create({
        data: {
          date: txn.date,
          supplierName,
          description: d.memo?.trim() || txn.description || '',
          accountId: d.accountId,
          taxCode: d.taxCode,
          amountExGst,
          gstAmount,
          amountIncGst,
          status: 'RECONCILED',
          bankTransactionId: id,
          userId: authResult.id,
          enteredByName: authResult.name || authResult.email || null,
          notes: null,
        },
      })

      await tx.bankTransaction.update({
        where: { id },
        data: {
          status: 'MATCHED',
          matchType: 'EXPENSE',
          memo: d.memo ?? null,
          transactionType: d.transactionType,
          taxCode: d.taxCode,
          // accountId intentionally NOT set — the linked Expense record owns the account
          // assignment for EXPENSE-type postings; setting it here causes a double entry
          // in the Chart of Accounts ledger.
        },
      })

      return newExpense
    })
  } else {
    // Transfer / Deposit / ReceivePayment — mark MATCHED with MANUAL type
    await prisma.bankTransaction.update({
      where: { id },
      data: {
        status: 'MATCHED',
        matchType: 'MANUAL',
        memo: d.memo ?? null,
        transactionType: d.transactionType,
        taxCode: d.taxCode,
        accountId: d.accountId,
      },
    })
  }

  // Reload and return updated transaction
  const updated = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { id: true, name: true } },
      expense: { include: { account: true } },
      account: true,
      invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true } },
    },
  })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated!) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
