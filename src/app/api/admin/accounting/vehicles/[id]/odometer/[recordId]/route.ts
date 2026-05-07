import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string }> },
) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-odometer-delete',
    authResult.id,
  )
  if (rateLimitResult) return rateLimitResult

  const { id: vehicleId, recordId } = await params

  const record = await prisma.vehicleYearlyOdometer.findFirst({
    where: { id: recordId, vehicleId },
  })
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.vehicleYearlyOdometer.delete({ where: { id: recordId } })

  return NextResponse.json({ ok: true })
}
