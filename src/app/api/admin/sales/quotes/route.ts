import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { salesQuoteFromDb } from '@/lib/sales/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_LIST = 2000

const createSchema = z.object({
  quoteNumber: z.string().trim().max(50).optional().nullable(),
  clientId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional().nullable(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().max(20000).optional().nullable(),
  terms: z.string().max(20000).optional().nullable(),
  items: z.array(z.any()).default([]),
})

function pad6(n: number): string {
  return String(n).padStart(6, '0')
}

async function nextQuoteNumber(tx: any): Promise<string> {
  const seq = await tx.salesSequence.upsert({
    where: { id: 'default' },
    create: { id: 'default', quote: 1, invoice: 0 },
    update: { quote: { increment: 1 } },
    select: { quote: true },
  })
  return `EST-${pad6(Number(seq.quote))}`
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-quotes-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const projectId = url.searchParams.get('projectId')
  const clientId = url.searchParams.get('clientId')
  const limitRaw = url.searchParams.get('limit')
  const limit = Math.min(MAX_LIST, Math.max(1, Number(limitRaw || MAX_LIST) || MAX_LIST))

  const rows = await prisma.salesQuote.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(clientId ? { clientId } : {}),
    },
    orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  })

  const res = NextResponse.json({ quotes: rows.map((r: any) => salesQuoteFromDb(r)) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-quotes-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data

  const created = await prisma.$transaction(async (tx) => {
    const quoteNumber = input.quoteNumber?.trim() || (await nextQuoteNumber(tx))

    const row = await tx.salesQuote.create({
      data: {
        quoteNumber,
        clientId: input.clientId,
        projectId: input.projectId || null,
        issueDate: input.issueDate,
        validUntil: input.validUntil || null,
        notes: input.notes || '',
        terms: input.terms || '',
        itemsJson: input.items,
        remindersEnabled: true,
      },
    })

    await tx.salesQuoteRevision.create({
      data: {
        quoteId: row.id,
        version: row.version,
        docJson: salesQuoteFromDb(row as any),
        createdByUserId: authResult.id,
      },
    })

    return row
  })

  return NextResponse.json({ ok: true, quote: salesQuoteFromDb(created as any) })
}
