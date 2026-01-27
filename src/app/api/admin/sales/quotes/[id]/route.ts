import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { salesQuoteFromDb } from '@/lib/sales/db-mappers'
import { upsertSalesDocumentShareForDoc } from '@/lib/sales/server-document-share'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['OPEN', 'SENT', 'ACCEPTED', 'CLOSED']).optional(),
  acceptedFromStatus: z.enum(['OPEN', 'SENT', 'ACCEPTED', 'CLOSED']).nullable().optional(),
  clientId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).nullable().optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(20000).optional(),
  terms: z.string().max(20000).optional(),
  items: z.array(z.any()).optional(),
  sentAt: z.string().datetime().nullable().optional(),
  remindersEnabled: z.boolean().optional(),
})

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-quote-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await ctx.params

  const row = await prisma.salesQuote.findUnique({ where: { id } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const res = NextResponse.json({ quote: salesQuoteFromDb(row as any) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-quote-patch',
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
      const current = await tx.salesQuote.findUnique({ where: { id } })
      if (!current) return null

      if (Number(current.version) !== Number(input.version)) {
        return { conflict: true, current }
      }

      const nextVersion = Number(current.version) + 1

      const next = await tx.salesQuote.update({
        where: { id },
        data: {
          ...(input.status ? { status: input.status as any } : {}),
          ...(input.acceptedFromStatus !== undefined ? { acceptedFromStatus: input.acceptedFromStatus as any } : {}),
          ...(input.clientId ? { clientId: input.clientId } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId || null } : {}),
          ...(input.issueDate ? { issueDate: input.issueDate } : {}),
          ...(input.validUntil !== undefined ? { validUntil: input.validUntil || null } : {}),
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

      await tx.salesQuoteRevision.create({
        data: {
          quoteId: next.id,
          version: next.version,
          docJson: salesQuoteFromDb(next as any),
          createdByUserId: authResult.id,
        },
      })

      // Keep the public sales share snapshot in sync with edits.
      try {
        await upsertSalesDocumentShareForDoc(tx as any, {
          type: 'QUOTE',
          doc: salesQuoteFromDb(next as any),
          clientId: next.clientId,
          projectId: next.projectId,
          quoteValidUntilYmd: next.validUntil,
        })
      } catch {
        // Best-effort; do not block quote edits.
      }

      return { conflict: false, row: next }
    })

    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if ((updated as any).conflict) {
      const current = (updated as any).current
      return NextResponse.json(
        { error: 'Conflict', current: salesQuoteFromDb(current as any) },
        { status: 409 }
      )
    }

    return NextResponse.json({ ok: true, quote: salesQuoteFromDb((updated as any).row) })
  } catch (e) {
    console.error('Failed to patch quote:', e)
    return NextResponse.json({ error: 'Unable to update quote' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-quote-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await ctx.params

  try {
    await prisma.$transaction(async (tx) => {
      await tx.salesDocumentShare.updateMany({
        where: { type: 'QUOTE', docId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      await tx.salesQuote.delete({ where: { id } })
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Failed to delete quote:', e)
    return NextResponse.json({ error: 'Unable to delete quote' }, { status: 500 })
  }
}
