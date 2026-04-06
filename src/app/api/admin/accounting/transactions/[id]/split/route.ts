import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAX_CODES = ['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED'] as const

const splitLineSchema = z.object({
  accountId: z.string().min(1),
  description: z.string().trim().max(2000).optional().default(''),
  amountCents: z.number().int(),
  taxCode: z.enum(TAX_CODES).default('BAS_EXCLUDED'),
})

const splitSchema = z.object({
  lines: z.array(splitLineSchema).min(2, 'At least 2 split lines required'),
})

// POST /api/admin/accounting/transactions/[id]/split
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-split',
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
      splitLines: { include: { account: true } },
    },
  })

  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.status === 'MATCHED') return NextResponse.json({ error: 'Transaction is already posted' }, { status: 409 })

  const body = await request.json().catch(() => null)
  const parsed = splitSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  const { lines } = parsed.data

  // Verify lines sum to the transaction amount
  const lineSum = lines.reduce((sum, l) => sum + l.amountCents, 0)
  if (lineSum !== txn.amountCents) {
    return NextResponse.json({
      error: `Split lines must sum to the transaction amount. Expected ${txn.amountCents}, got ${lineSum}.`,
    }, { status: 400 })
  }

  // Verify all accounts exist
  const accountIds = [...new Set(lines.map(l => l.accountId))]
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true },
  })
  if (accounts.length !== accountIds.length) {
    return NextResponse.json({ error: 'One or more accounts not found' }, { status: 400 })
  }

  await prisma.$transaction(async (tx) => {
    // Create split lines
    for (const line of lines) {
      await tx.splitLine.create({
        data: {
          bankTransactionId: id,
          accountId: line.accountId,
          description: line.description || '',
          amountCents: line.amountCents,
          taxCode: line.taxCode,
        },
      })
    }

    // Mark transaction as MATCHED with SPLIT type
    await tx.bankTransaction.update({
      where: { id },
      data: {
        status: 'MATCHED',
        matchType: 'SPLIT',
        transactionType: txn.amountCents < 0 ? 'Expense' : 'Deposit',
      },
    })
  })

  // Reload and return
  const updated = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { id: true, name: true } },
      expense: { include: { account: true } },
      account: true,
      invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true } },
      splitLines: { include: { account: true } },
    },
  })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated!) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
