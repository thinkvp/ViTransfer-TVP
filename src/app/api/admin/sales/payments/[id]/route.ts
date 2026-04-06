import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-payment-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await ctx.params

  try {
    // Fetch invoiceId before deletion so we can recompute invoice status afterward
    const payment = await prisma.salesPayment.findUnique({ where: { id }, select: { invoiceId: true } })
    await prisma.salesPayment.delete({ where: { id } })
    if (payment?.invoiceId) {
      await recomputeInvoiceStoredStatus(prisma as any, payment.invoiceId, { createdByUserId: authResult.id })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Failed to delete payment:', e)
    return NextResponse.json({ error: 'Unable to delete payment' }, { status: 500 })
  }
}
