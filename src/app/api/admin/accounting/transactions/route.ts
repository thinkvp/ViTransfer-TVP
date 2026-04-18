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
  const sortKeyRaw = searchParams.get('sortKey') ?? 'date'
  const sortDir = (searchParams.get('sortDir') ?? 'desc') === 'asc' ? 'asc' : 'desc'
  const sortKey = ['date', 'description', 'amount'].includes(sortKeyRaw) ? sortKeyRaw : 'date'

  const where: Record<string, unknown> = {}
  if (bankAccountId) where.bankAccountId = bankAccountId
  if (status) where.status = status
  if (importBatchId) where.importBatchId = importBatchId
  if (from && to) where.date = { gte: from, lte: to }
  else if (from) where.date = { gte: from }
  else if (to) where.date = { lte: to }
  if (search) {
    const orConditions: object[] = [
      { description: { contains: search, mode: 'insensitive' } },
      { reference: { contains: search, mode: 'insensitive' } },
    ]
    const cleaned = search.replace(/[$,]/g, '')
    const numericValue = parseFloat(cleaned)
    if (!isNaN(numericValue) && numericValue >= 0) {
      if (cleaned.includes('.')) {
        // Decimal entered — exact match
        const cents = Math.round(numericValue * 100)
        orConditions.push({ amountCents: cents }, { amountCents: -cents })
      } else {
        // Whole number — match all dollar amounts whose digits start with this value
        // e.g. "132" matches $132.xx (13200-13299), $1,320.xx (132000-132999), $13,200.xx, etc.
        const base = Math.round(numericValue)
        for (let k = 0; k <= 4; k++) {
          const factor = Math.pow(10, k)
          const lo = base * factor * 100
          const hi = (base + 1) * factor * 100
          orConditions.push(
            { amountCents: { gte: lo, lt: hi } },
            { amountCents: { gt: -hi, lte: -lo } },
          )
        }
      }
    }
    where.OR = orConditions
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
      orderBy: sortKey === 'description'
        ? [{ description: sortDir } as const]
        : sortKey === 'amount'
          ? [{ amountCents: sortDir } as const]
          : [{ date: sortDir } as const, { createdAt: sortDir } as const],
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
