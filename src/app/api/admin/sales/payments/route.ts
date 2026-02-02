import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { salesPaymentFromDb } from '@/lib/sales/db-mappers'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_LIST = 5000

const createSchema = z.object({
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.number().int().min(0).max(2_000_000_000),
  method: z.string().trim().max(200),
  reference: z.string().trim().max(500),
  clientId: z.string().trim().min(1).nullable().optional(),
  invoiceId: z.string().trim().min(1).nullable().optional(),
})

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-payments-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const invoiceId = url.searchParams.get('invoiceId')
  const clientId = url.searchParams.get('clientId')
  const limitRaw = url.searchParams.get('limit')
  const limit = Math.min(MAX_LIST, Math.max(1, Number(limitRaw || MAX_LIST) || MAX_LIST))

  const rows = await prisma.salesPayment.findMany({
    where: {
      ...(invoiceId ? { invoiceId } : {}),
      ...(clientId ? { clientId } : {}),
    },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  })

  const res = NextResponse.json({ payments: rows.map((r: any) => salesPaymentFromDb(r)) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-payments-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.salesPayment.create({
      data: {
        source: 'MANUAL' as any,
        paymentDate: input.paymentDate,
        amountCents: input.amountCents,
        method: input.method,
        reference: input.reference,
        clientId: input.clientId || null,
        invoiceId: input.invoiceId || null,
      },
    })

    if (created.invoiceId) {
      await recomputeInvoiceStoredStatus(tx as any, String(created.invoiceId), { createdByUserId: authResult.id })
    }

    return created
  })

  return NextResponse.json({ ok: true, payment: salesPaymentFromDb(row as any) })
}
