import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { accountFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COGS', 'EXPENSE']),
  subType: z.string().trim().max(100).optional().nullable(),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']).default('GST'),
  description: z.string().trim().max(2000).optional().nullable(),
  isActive: z.boolean().default(true),
  parentId: z.string().trim().max(100).optional().nullable(),
  sortOrder: z.number().int().min(0).max(99999).default(0),
})

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-accounts-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const typeFilter = url.searchParams.get('type')
  const activeOnly = url.searchParams.get('activeOnly') === 'true'
  const expenseTypes = url.searchParams.get('expenseTypes') === 'true'

  const where: any = {}
  if (typeFilter) {
    where.type = typeFilter
  } else if (expenseTypes) {
    where.type = { in: ['EXPENSE', 'COGS'] }
  }
  if (activeOnly) {
    where.isActive = true
  }
  // For tree views (no type/expense filter), only return top-level accounts;
  // children are included via the nested include below.
  // For dropdown queries (expenseTypes / typeFilter), return all accounts flat.
  if (!typeFilter && !expenseTypes) {
    where.parentId = null
  }

  const rows = await prisma.account.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    include: { children: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
  })

  const res = NextResponse.json({ accounts: rows.map(accountFromDb) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-accounts-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data

  // Check code uniqueness
  const existing = await prisma.account.findUnique({ where: { code: data.code } })
  if (existing) {
    return NextResponse.json({ error: 'Account code already in use' }, { status: 409 })
  }

  const account = await prisma.account.create({
    data: {
      code: data.code,
      name: data.name,
      type: data.type,
      subType: data.subType ?? null,
      taxCode: data.taxCode,
      description: data.description ?? null,
      isActive: data.isActive,
      parentId: data.parentId ?? null,
      sortOrder: data.sortOrder,
      isSystem: false,
    },
  })

  const res = NextResponse.json({ account: accountFromDb(account) }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
