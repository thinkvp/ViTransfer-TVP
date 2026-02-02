import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { salesInvoiceFromDb } from '@/lib/sales/db-mappers'
import { upsertSalesDocumentShareForDoc } from '@/lib/sales/server-document-share'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['OPEN', 'SENT', 'OVERDUE', 'PARTIALLY_PAID', 'PAID']).optional(),
  clientId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).nullable().optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(20000).optional(),
  terms: z.string().max(20000).optional(),
  items: z.array(z.any()).optional(),
  sentAt: z.string().datetime().nullable().optional(),
  remindersEnabled: z.boolean().optional(),
})

async function computeInvoicePaidAtYmdForExpiry(tx: any, invoiceId: string): Promise<string | null> {
  const id = String(invoiceId || '').trim()
  if (!id) return null

  const paymentsAgg = await tx.salesPayment.aggregate({
    where: { invoiceId: id, excludeFromInvoiceBalance: false },
    _max: { paymentDate: true },
  }).catch(() => null)

  const stripeAgg = await tx.salesInvoiceStripePayment.aggregate({
    where: { invoiceDocId: id },
    _max: { createdAt: true },
  }).catch(() => null)

  const latestLocalYmd = typeof paymentsAgg?._max?.paymentDate === 'string' ? paymentsAgg._max.paymentDate : null

  const stripeCreatedAt = stripeAgg?._max?.createdAt
  const stripeIso = typeof stripeCreatedAt === 'string'
    ? stripeCreatedAt
    : (stripeCreatedAt && typeof (stripeCreatedAt as any).toISOString === 'function' ? (stripeCreatedAt as any).toISOString() : null)
  const latestStripeYmd = typeof stripeIso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(stripeIso) ? stripeIso.slice(0, 10) : null

  return [latestLocalYmd, latestStripeYmd]
    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    .sort()
    .at(-1)
    ?? null
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-invoice-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await ctx.params

  const row = await prisma.salesInvoice.findUnique({ where: { id } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const res = NextResponse.json({ invoice: salesInvoiceFromDb(row as any) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-invoice-patch',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await ctx.params

  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.salesInvoice.findUnique({ where: { id } })
      if (!current) return null

      if (Number(current.version) !== Number(input.version)) {
        return { conflict: true, current }
      }

      const nextVersion = Number(current.version) + 1

      const next = await tx.salesInvoice.update({
        where: { id },
        data: {
          ...(input.status ? { status: input.status as any } : {}),
          ...(input.clientId ? { clientId: input.clientId } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId || null } : {}),
          ...(input.issueDate ? { issueDate: input.issueDate } : {}),
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate || null } : {}),
          ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
          ...(typeof input.terms === 'string' ? { terms: input.terms } : {}),
          ...(input.items ? { itemsJson: input.items } : {}),
          ...(input.sentAt !== undefined
            ? { sentAt: input.sentAt ? new Date(input.sentAt) : null }
            : {}),
          ...(input.remindersEnabled !== undefined ? { remindersEnabled: input.remindersEnabled } : {}),
          version: nextVersion,
        },
      })

      await tx.salesInvoiceRevision.create({
        data: {
          invoiceId: next.id,
          version: next.version,
          docJson: salesInvoiceFromDb(next as any),
          createdByUserId: authResult.id,
        },
      })

      // Keep the public sales share snapshot in sync with edits.
      // IMPORTANT: Preserve expiry for paid invoices by deriving paidAt from payment records.
      try {
        const invoicePaidAtYmd = next.status === 'PAID'
          ? await computeInvoicePaidAtYmdForExpiry(tx as any, next.id)
          : null

        await upsertSalesDocumentShareForDoc(tx as any, {
          type: 'INVOICE',
          doc: salesInvoiceFromDb(next as any),
          clientId: next.clientId,
          projectId: next.projectId,
          invoicePaidAtYmd,
        })
      } catch {
        // Best-effort; do not block invoice edits.
      }

      return { conflict: false, row: next }
    })

    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if ((updated as any).conflict) {
      const current = (updated as any).current
      return NextResponse.json(
        { error: 'Conflict', current: salesInvoiceFromDb(current as any) },
        { status: 409 }
      )
    }

    return NextResponse.json({ ok: true, invoice: salesInvoiceFromDb((updated as any).row) })
  } catch (e) {
    console.error('Failed to patch invoice:', e)
    return NextResponse.json({ error: 'Unable to update invoice' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-invoice-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await ctx.params

  try {
    await prisma.$transaction(async (tx) => {
      await tx.salesDocumentShare.updateMany({
        where: { type: 'INVOICE', docId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      await tx.salesInvoice.delete({ where: { id } })
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Failed to delete invoice:', e)
    return NextResponse.json({ error: 'Unable to delete invoice' }, { status: 500 })
  }
}
