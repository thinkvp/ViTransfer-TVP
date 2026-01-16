import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// DELETE /api/users/me/key-dates/[keyDateId]
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ keyDateId: string }> }) {
  const { keyDateId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'user-key-dates-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const existing = await prisma.userKeyDate.findUnique({ where: { id: keyDateId } })
  if (!existing || existing.userId !== authResult.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  await prisma.userKeyDate.delete({ where: { id: keyDateId } })
  return NextResponse.json({ ok: true })
}
