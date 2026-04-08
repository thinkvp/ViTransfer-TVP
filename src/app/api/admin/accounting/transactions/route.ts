import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transactions-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const bankAccountId = searchParams.get('bankAccountId')
  const status = searchParams.get('status')
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const search = searchParams.get('search')
  const importBatchId = searchParams.get('importBatchId')
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '50', 10)))

  const where: Record<string, unknown> = {}
  if (bankAccountId) where.bankAccountId = bankAccountId
  if (status) where.status = status
  if (importBatchId) where.importBatchId = importBatchId
  if (from && to) where.date = { gte: from, lte: to }
  else if (from) where.date = { gte: from }
  else if (to) where.date = { lte: to }
  if (search) {
    where.OR = [
      { description: { contains: search, mode: 'insensitive' } },
      { reference: { contains: search, mode: 'insensitive' } },
    ]
  }

  const [total, rows] = await Promise.all([
    prisma.bankTransaction.count({ where }),
    prisma.bankTransaction.findMany({
      where,
      include: {
        bankAccount: { select: { id: true, name: true } },
        expense: { include: { account: true } },
        account: true,
        invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true, invoice: { select: { invoiceNumber: true, clientId: true, client: { select: { name: true } } } } } },
        splitLines: { include: { account: true } },
        accountingAttachments: { orderBy: { uploadedAt: 'asc' } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const res = NextResponse.json({
    transactions: rows.map(bankTransactionFromDb),
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
