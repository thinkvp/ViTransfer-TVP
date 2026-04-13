import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankAccountFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  bsb: z.string().trim().regex(/^\d{3}-?\d{3}$/, 'BSB must be 6 digits').optional().nullable(),
  accountNumber: z.string().trim().min(1).max(50),
  bankName: z.string().trim().max(100).optional().nullable(),
  currency: z.string().trim().length(3).default('AUD'),
  openingBalance: z.number().min(0).default(0).describe('Opening balance in dollars'),
  openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
})

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bank-accounts-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const accounts = await prisma.bankAccount.findMany({
    include: { _count: { select: { transactions: true } } },
    orderBy: { createdAt: 'asc' },
  })

  // Compute current balance = openingBalance + SUM of all non-excluded transaction amounts
  const txnSums = await prisma.bankTransaction.groupBy({
    by: ['bankAccountId'],
    where: { status: { not: 'EXCLUDED' } },
    _sum: { amountCents: true },
  })
  const sumByAccountId = Object.fromEntries(txnSums.map(r => [r.bankAccountId, r._sum.amountCents ?? 0]))

  const pendingTxnSums = await prisma.bankTransaction.groupBy({
    by: ['bankAccountId'],
    where: { status: 'UNMATCHED' },
    _sum: { amountCents: true },
  })
  const pendingSumByAccountId = Object.fromEntries(pendingTxnSums.map(r => [r.bankAccountId, r._sum.amountCents ?? 0]))

  const accountsWithBalance = accounts.map(a => ({
    ...a,
    currentBalance: Number(a.openingBalance) + (sumByAccountId[a.id] ?? 0),
    pendingTransactionAmount: pendingSumByAccountId[a.id] ?? 0,
  }))

  const res = NextResponse.json({ bankAccounts: accountsWithBalance.map(bankAccountFromDb) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bank-accounts-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const d = parsed.data

  const bankAccount = await prisma.bankAccount.create({
    data: {
      name: d.name,
      bsb: d.bsb ?? null,
      accountNumber: d.accountNumber,
      bankName: d.bankName ?? null,
      currency: d.currency,
      openingBalance: Math.round((d.openingBalance ?? 0) * 100),
      openingBalanceDate: d.openingBalanceDate ?? null,
    },
    include: { _count: { select: { transactions: true } } },
  })

  const res = NextResponse.json({ bankAccount: bankAccountFromDb(bankAccount) }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
