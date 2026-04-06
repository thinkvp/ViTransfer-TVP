import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// DELETE /api/admin/accounting/journal-entries/[id]
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' }, 'accounting-journal-entries-delete', authResult.id)
  if (rl) return rl

  const { id } = await params
  const entry = await prisma.journalEntry.findUnique({ where: { id } })
  if (!entry) return NextResponse.json({ error: 'Journal entry not found' }, { status: 404 })

  await prisma.journalEntry.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
