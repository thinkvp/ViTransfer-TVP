import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-presets-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params

  const existing = await prisma.salesPreset.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Preset not found' }, { status: 404 })
  }

  await prisma.salesPreset.delete({ where: { id } })

  return NextResponse.json({ ok: true })
}
