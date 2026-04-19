import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { journalEntryFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  description: z.string().trim().min(1).max(5000),
  amountCents: z.number().int(),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']).default('BAS_EXCLUDED'),
  reference: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

// PUT /api/admin/accounting/journal-entries/[id]
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' }, 'accounting-journal-entries-put', authResult.id)
  if (rl) return rl

  const { id } = await params
  const existing = await prisma.journalEntry.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Journal entry not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data
  const entry = await prisma.journalEntry.update({
    where: { id },
    data: {
      date: data.date,
      description: data.description,
      amountCents: data.amountCents,
      taxCode: data.taxCode,
      reference: data.reference ?? null,
      notes: data.notes ?? null,
    },
    include: { account: { select: { code: true, name: true } } },
  })

  const res = NextResponse.json({ entry: journalEntryFromDb(entry) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

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
