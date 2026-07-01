import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { salesInvoiceFromDb } from '@/lib/sales/db-mappers'
import { upsertSalesDocumentShareForDoc } from '@/lib/sales/server-document-share'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  version: z.number().int().min(1),
  action: z.enum(['VOID', 'UNVOID']),
})

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-invoice-void',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await ctx.params

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const { version, action } = parsed.data

  try {
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesInvoice.findUnique({ where: { id } })
      if (!current) return { notFound: true as const }

      if (Number(current.version) !== Number(version)) {
        return { conflict: true as const, current }
      }

      if (action === 'VOID') {
        if ((current.status as string) === 'VOID') {
          return { badRequest: 'Invoice is already void.' as const }
        }

        // Only unpaid invoices may be voided. Reject anything with real money
        // attached (manual or Stripe payments), regardless of stored status.
        const [manualAgg, stripeAgg] = await Promise.all([
          tx.salesPayment.aggregate({
            where: { invoiceId: id, excludeFromInvoiceBalance: false },
            _sum: { amountCents: true },
          }),
          tx.salesInvoiceStripePayment.aggregate({
            where: { invoiceDocId: id },
            _sum: { invoiceAmountCents: true },
          }),
        ])
        const paidCents =
          Number(manualAgg?._sum?.amountCents ?? 0) + Number(stripeAgg?._sum?.invoiceAmountCents ?? 0)

        if (paidCents > 0 || current.status === 'PAID' || current.status === 'PARTIALLY_PAID') {
          return { badRequest: 'Cannot void an invoice with payments.' as const }
        }

        const nextVersion = Number(current.version) + 1
        const next = await tx.salesInvoice.update({
          where: { id },
          data: { status: 'VOID', version: nextVersion },
        })

        await tx.salesInvoiceRevision.create({
          data: {
            invoiceId: next.id,
            version: next.version,
            docJson: salesInvoiceFromDb(next as any),
            createdByUserId: authResult.id,
          },
        })

        // Revoke any active public share so the client link stops resolving.
        await tx.salesDocumentShare.updateMany({
          where: { type: 'INVOICE', docId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        })

        return { ok: true as const, row: next }
      }

      // action === 'UNVOID'
      if ((current.status as string) !== 'VOID') {
        return { badRequest: 'Only a void invoice can be un-voided.' as const }
      }

      const nextVersion = Number(current.version) + 1
      const next = await tx.salesInvoice.update({
        where: { id },
        data: { status: 'OPEN', version: nextVersion },
      })

      await tx.salesInvoiceRevision.create({
        data: {
          invoiceId: next.id,
          version: next.version,
          docJson: salesInvoiceFromDb(next as any),
          createdByUserId: authResult.id,
        },
      })

      // Re-create the public share so the invoice is viewable again.
      try {
        await upsertSalesDocumentShareForDoc(tx, {
          type: 'INVOICE',
          doc: salesInvoiceFromDb(next as any),
          clientId: next.clientId,
          projectId: next.projectId,
        })
      } catch {
        // Best-effort; do not block the un-void.
      }

      return { ok: true as const, row: next }
    })

    if ('notFound' in result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if ('conflict' in result) {
      return NextResponse.json(
        { error: 'Conflict', current: salesInvoiceFromDb(result.current as any) },
        { status: 409 }
      )
    }
    if ('badRequest' in result) {
      return NextResponse.json({ error: result.badRequest }, { status: 400 })
    }

    return NextResponse.json({ ok: true, invoice: salesInvoiceFromDb(result.row as any) })
  } catch (e) {
    console.error('Failed to void/un-void invoice:', e)
    return NextResponse.json({ error: 'Unable to update invoice' }, { status: 500 })
  }
}
