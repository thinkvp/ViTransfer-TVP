import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getAccountingSettings, saveAccountingSettings } from '@/lib/accounting/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const settingsSchema = z.object({
  reportingBasis: z.enum(['CASH', 'ACCRUAL']).default('ACCRUAL'),
  basGstAccountId: z.string().trim().min(1).optional().nullable(),
  basPaygAccountId: z.string().trim().min(1).optional().nullable(),
})

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-settings-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const settings = await getAccountingSettings()
  const res = NextResponse.json(settings)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-settings-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = settingsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const settings = await saveAccountingSettings(parsed.data)
  return NextResponse.json({ ok: true, settings })
}