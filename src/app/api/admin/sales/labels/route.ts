import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(200),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
  accountId: z.string().trim().min(1).max(100).optional().nullable(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(99999).default(0),
})

function mapLabel(row: any) {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? null,
    accountId: row.accountId ?? null,
    accountName: row.account?.name ?? null,
    accountCode: row.account?.code ?? null,
    isActive: Boolean(row.isActive),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-labels-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const activeOnly = url.searchParams.get('activeOnly') === 'true'

  const rows = await prisma.salesLabel.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { account: { select: { name: true, code: true } } },
  })

  const res = NextResponse.json({ labels: rows.map(mapLabel) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-labels-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = createLabelSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { name, color, accountId, isActive, sortOrder } = parsed.data

  const existing = await prisma.salesLabel.findUnique({ where: { name } })
  if (existing) {
    return NextResponse.json({ error: 'A label with this name already exists.' }, { status: 409 })
  }

  const label = await prisma.salesLabel.create({
    data: { name, color: color ?? null, accountId: accountId ?? null, isActive, sortOrder },
    include: { account: { select: { name: true, code: true } } },
  })

  const res = NextResponse.json({ ok: true, label: mapLabel(label) }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
