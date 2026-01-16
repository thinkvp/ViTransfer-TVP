import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  overdueInvoiceRemindersEnabled: z.boolean(),
  overdueInvoiceBusinessDaysAfterDue: z.number().int().min(1).max(60),
  quoteExpiryRemindersEnabled: z.boolean(),
  quoteExpiryBusinessDaysBeforeValidUntil: z.number().int().min(1).max(60),
})

function normalizeRow(row: any) {
  return {
    overdueInvoiceRemindersEnabled: Boolean(row?.overdueInvoiceRemindersEnabled),
    overdueInvoiceBusinessDaysAfterDue: Number.isFinite(Number(row?.overdueInvoiceBusinessDaysAfterDue))
      ? Math.max(1, Math.trunc(Number(row.overdueInvoiceBusinessDaysAfterDue)))
      : 3,
    quoteExpiryRemindersEnabled: Boolean(row?.quoteExpiryRemindersEnabled),
    quoteExpiryBusinessDaysBeforeValidUntil: Number.isFinite(Number(row?.quoteExpiryBusinessDaysBeforeValidUntil))
      ? Math.max(1, Math.trunc(Number(row.quoteExpiryBusinessDaysBeforeValidUntil)))
      : 3,
  }
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-reminder-settings-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const row = await (prisma as any).salesReminderSettings
    .findUnique({ where: { id: 'default' } })
    .catch(() => null)

  const res = NextResponse.json(normalizeRow(row))
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-reminder-settings-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = updateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data

  await (prisma as any).salesReminderSettings.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      overdueInvoiceRemindersEnabled: input.overdueInvoiceRemindersEnabled,
      overdueInvoiceBusinessDaysAfterDue: input.overdueInvoiceBusinessDaysAfterDue,
      quoteExpiryRemindersEnabled: input.quoteExpiryRemindersEnabled,
      quoteExpiryBusinessDaysBeforeValidUntil: input.quoteExpiryBusinessDaysBeforeValidUntil,
    },
    update: {
      overdueInvoiceRemindersEnabled: input.overdueInvoiceRemindersEnabled,
      overdueInvoiceBusinessDaysAfterDue: input.overdueInvoiceBusinessDaysAfterDue,
      quoteExpiryRemindersEnabled: input.quoteExpiryRemindersEnabled,
      quoteExpiryBusinessDaysBeforeValidUntil: input.quoteExpiryBusinessDaysBeforeValidUntil,
    },
  })

  const row = await (prisma as any).salesReminderSettings.findUnique({ where: { id: 'default' } })
  return NextResponse.json({ ok: true, ...normalizeRow(row) })
}
