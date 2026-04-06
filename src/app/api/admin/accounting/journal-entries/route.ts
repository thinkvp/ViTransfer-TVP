import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { journalEntryFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  accountId: z.string().trim().min(1),
  description: z.string().trim().min(1).max(5000),
  amountCents: z.number().int(),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']).default('BAS_EXCLUDED'),
  reference: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

// GET /api/admin/accounting/journal-entries?accountId=xxx&from=&to=&page=&pageSize=
export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 120, message: 'Too many requests.' }, 'accounting-journal-entries-get', authResult.id)
  if (rl) return rl

  const url = new URL(request.url)
  const accountId = url.searchParams.get('accountId')
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10))
  const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '50', 10)))

  const where: Record<string, unknown> = {}
  if (accountId) where.accountId = accountId
  if (from && to) where.date = { gte: from, lte: to }
  else if (from) where.date = { gte: from }
  else if (to) where.date = { lte: to }

  const [total, rows] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({
      where,
      include: { account: { select: { code: true, name: true } } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const res = NextResponse.json({
    entries: rows.map(journalEntryFromDb),
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// POST /api/admin/accounting/journal-entries
export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' }, 'accounting-journal-entries-post', authResult.id)
  if (rl) return rl

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const d = parsed.data

  const account = await prisma.account.findUnique({ where: { id: d.accountId } })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const entry = await prisma.journalEntry.create({
    data: {
      date: d.date,
      accountId: d.accountId,
      description: d.description,
      amountCents: d.amountCents,
      taxCode: d.taxCode,
      reference: d.reference ?? null,
      notes: d.notes ?? null,
      userId: authResult.id,
      enteredByName: authResult.name ?? authResult.email ?? null,
    },
    include: { account: { select: { code: true, name: true } } },
  })

  const res = NextResponse.json({ entry: journalEntryFromDb(entry) }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
