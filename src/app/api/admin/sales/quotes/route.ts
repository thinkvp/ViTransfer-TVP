import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { salesQuoteFromDb } from '@/lib/sales/db-mappers'
import { upsertSalesDocumentShareForDoc } from '@/lib/sales/server-document-share'

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
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

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

  const ids = rows.map((r: any) => String(r?.id ?? '')).filter(Boolean)
  const openedAgg = ids.length
    ? await prisma.salesEmailTracking.groupBy({
        by: ['docId'],
        where: { type: 'QUOTE', docId: { in: ids }, openedAt: { not: null } },
        _count: { _all: true },
      })
    : ([] as any[])

  const openedSet = new Set((openedAgg as any[]).map((g) => String(g?.docId ?? '').trim()).filter(Boolean))

  const quotes = rows.map((r: any) => {
    const q = salesQuoteFromDb(r)
    return { ...q, hasOpenedEmail: openedSet.has(q.id) }
  })

  const res = NextResponse.json({ quotes })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

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

    // Snapshot the current taxEnabled setting so it persists with the document.
    const settingsRow = await tx.salesSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
      select: { taxEnabled: true },
    })
    const taxEnabled = typeof (settingsRow as any)?.taxEnabled === 'boolean' ? (settingsRow as any).taxEnabled : true

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
        taxEnabled,
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

    // Create the public sales share token immediately so Views & Tracking
    // is available even before the first email is sent.
    try {
      await upsertSalesDocumentShareForDoc(tx as any, {
        type: 'QUOTE',
        doc: salesQuoteFromDb(row as any),
        clientId: row.clientId,
        projectId: row.projectId,
        quoteValidUntilYmd: row.validUntil,
      })
    } catch (e) {
      // Best-effort; do not block quote creation.
      console.error('[SALES] Failed to create quote share token:', e)
    }

    return row
  })

  return NextResponse.json({ ok: true, quote: salesQuoteFromDb(created as any) })
}
