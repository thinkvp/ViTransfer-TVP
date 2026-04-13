import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { expenseFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  supplierName: z.string().trim().max(300).optional().nullable(),
  description: z.string().trim().min(1).max(5000),
  accountId: z.string().trim().min(1),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']).default('GST'),
  amountIncGst: z.number().positive().describe('Amount including GST in dollars'),
  notes: z.string().trim().max(5000).optional().nullable(),
})

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-expenses-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const accountId = searchParams.get('accountId')
  const supplierName = searchParams.get('supplierName')
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '50', 10)))
  const sortKeyRaw = searchParams.get('sortKey') ?? 'date'
  const sortDir = (searchParams.get('sortDir') ?? 'desc') === 'asc' ? 'asc' : 'desc'
  const validSortKeys = ['date', 'supplier', 'description', 'category', 'amountExGst', 'gstAmount', 'amountIncGst', 'status']
  const sortKey = validSortKeys.includes(sortKeyRaw) ? sortKeyRaw : 'date'

  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (accountId) where.accountId = accountId
  if (supplierName) where.OR = [
    { supplierName: { contains: supplierName, mode: 'insensitive' } },
    { description: { contains: supplierName, mode: 'insensitive' } },
  ]
  // date is stored as YYYY-MM-DD string; string range comparison works correctly
  if (from && to) where.date = { gte: from, lte: to }
  else if (from) where.date = { gte: from }
  else if (to) where.date = { lte: to }

  const [total, rows] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({
      where,
      include: { account: true, user: { select: { id: true, name: true, email: true } }, accountingAttachments: { select: { id: true, storagePath: true, originalName: true, bankTransactionId: true, expenseId: true, uploadedAt: true } } },
      orderBy: sortKey === 'supplier' ? { supplierName: sortDir } as const
        : sortKey === 'description' ? { description: sortDir } as const
        : sortKey === 'category' ? { account: { name: sortDir } } as const
        : sortKey === 'amountExGst' ? { amountExGst: sortDir } as const
        : sortKey === 'gstAmount' ? { gstAmount: sortDir } as const
        : sortKey === 'amountIncGst' ? { amountIncGst: sortDir } as const
        : sortKey === 'status' ? { status: sortDir } as const
        : { date: sortDir } as const,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const res = NextResponse.json({
    expenses: rows.map(expenseFromDb),
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-expenses-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const d = parsed.data

  const account = await prisma.account.findUnique({ where: { id: d.accountId } })
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }
  if (!['EXPENSE', 'COGS'].includes(account.type)) {
    return NextResponse.json({ error: 'Account must be of type EXPENSE or COGS' }, { status: 400 })
  }

  // Convert dollar amount to cents, using configurable GST rate
  const amountIncGstCents = Math.round(d.amountIncGst * 100)
  let gstAmountCents = 0
  if (d.taxCode === 'GST') {
    const settings = await prisma.salesSettings.findUnique({ where: { id: 'default' }, select: { taxRatePercent: true } })
    const taxRate = (settings?.taxRatePercent ?? 10) / 100 // e.g. 0.10
    gstAmountCents = Math.round(amountIncGstCents * taxRate / (1 + taxRate))
  }
  const amountExGstCents = amountIncGstCents - gstAmountCents

  const expense = await prisma.expense.create({
    data: {
      date: d.date,
      supplierName: d.supplierName ?? undefined,
      description: d.description,
      accountId: d.accountId,
      taxCode: d.taxCode,
      amountExGst: amountExGstCents,
      gstAmount: gstAmountCents,
      amountIncGst: amountIncGstCents,
      userId: authResult.id,
      enteredByName: authResult.name ?? authResult.email ?? null,
      notes: d.notes ?? null,
      status: 'DRAFT',
    },
    include: { account: true, user: { select: { id: true, name: true, email: true } }, accountingAttachments: { select: { id: true, storagePath: true, originalName: true, bankTransactionId: true, expenseId: true, uploadedAt: true } } },
  })

  const res = NextResponse.json({ expense: expenseFromDb(expense) }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
