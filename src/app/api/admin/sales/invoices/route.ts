import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { salesInvoiceFromDb } from '@/lib/sales/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_LIST = 2000

const createSchema = z.object({
  invoiceNumber: z.string().trim().max(50).optional().nullable(),
  clientId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional().nullable(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().max(20000).optional().nullable(),
  terms: z.string().max(20000).optional().nullable(),
  items: z.array(z.any()).default([]),
})

function pad6(n: number): string {
  return String(n).padStart(6, '0')
}

async function nextInvoiceNumber(tx: any): Promise<string> {
  const seq = await tx.salesSequence.upsert({
    where: { id: 'default' },
    create: { id: 'default', quote: 0, invoice: 1 },
    update: { invoice: { increment: 1 } },
    select: { invoice: true },
  })
  return `INV-${pad6(Number(seq.invoice))}`
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-invoices-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const projectId = url.searchParams.get('projectId')
  const clientId = url.searchParams.get('clientId')
  const limitRaw = url.searchParams.get('limit')
  const limit = Math.min(MAX_LIST, Math.max(1, Number(limitRaw || MAX_LIST) || MAX_LIST))

  const rows = await prisma.salesInvoice.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(clientId ? { clientId } : {}),
    },
    orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  })

  const res = NextResponse.json({ invoices: rows.map((r: any) => salesInvoiceFromDb(r)) })
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
    'admin-sales-invoices-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data

  const created = await prisma.$transaction(async (tx) => {
    const invoiceNumber = input.invoiceNumber?.trim() || (await nextInvoiceNumber(tx))

    const row = await tx.salesInvoice.create({
      data: {
        invoiceNumber,
        clientId: input.clientId,
        projectId: input.projectId || null,
        issueDate: input.issueDate,
        dueDate: input.dueDate || null,
        notes: input.notes || '',
        terms: input.terms || '',
        itemsJson: input.items,
        remindersEnabled: true,
      },
    })

    await tx.salesInvoiceRevision.create({
      data: {
        invoiceId: row.id,
        version: row.version,
        docJson: salesInvoiceFromDb(row as any),
        createdByUserId: authResult.id,
      },
    })

    return row
  })

  return NextResponse.json({ ok: true, invoice: salesInvoiceFromDb(created as any) })
}
