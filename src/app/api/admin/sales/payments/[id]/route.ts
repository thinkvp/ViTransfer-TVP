import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

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
    await prisma.salesPayment.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Failed to delete payment:', e)
    return NextResponse.json({ error: 'Unable to delete payment' }, { status: 500 })
  }
}
