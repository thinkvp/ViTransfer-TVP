import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { salesInvoiceFromDb } from '@/lib/sales/db-mappers'
import { upsertSalesDocumentShareForDoc } from '@/lib/sales/server-document-share'

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
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

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
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

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

    // Create the public sales share token immediately so Views & Tracking
    // is available even before the first email is sent.
    try {
      await upsertSalesDocumentShareForDoc(tx as any, {
        type: 'INVOICE',
        doc: salesInvoiceFromDb(row as any),
        clientId: row.clientId,
        projectId: row.projectId,
      })
    } catch (e) {
      // Best-effort; do not block invoice creation.
      console.error('[SALES] Failed to create invoice share token:', e)
    }

    return row
  })

  return NextResponse.json({ ok: true, invoice: salesInvoiceFromDb(created as any) })
}
