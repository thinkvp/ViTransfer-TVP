import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { encrypt } from '@/lib/encryption'
import { getStripeGatewaySettings } from '@/lib/sales/stripe-gateway'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  enabled: z.boolean(),
  label: z.string().trim().min(1).max(300),
  feePercent: z.number().finite().min(0).max(100),
  feeFixedCents: z.number().finite().min(0).max(100000),
  publishableKey: z.string().trim().max(500).optional().nullable(),
  secretKey: z.string().trim().max(500).optional().nullable(),
  dashboardPaymentDescription: z.string().trim().min(1).max(300),
  currencies: z.string().trim().min(3).max(200),
})

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-stripe-settings-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const settings = await getStripeGatewaySettings()

  const res = NextResponse.json({
    enabled: settings.enabled,
    label: settings.label,
    feePercent: settings.feePercent,
    feeFixedCents: settings.feeFixedCents,
    publishableKey: settings.publishableKey,
    dashboardPaymentDescription: settings.dashboardPaymentDescription,
    currencies: settings.currencies.join(', '),
    hasSecretKey: Boolean(settings.secretKey),
    secretKeySource: settings.secretKeySource,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-sales-stripe-settings-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const parsed = updateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const input = parsed.data
  const publishableKey = typeof input.publishableKey === 'string' && input.publishableKey.trim() ? input.publishableKey.trim() : null

  const secretKey = typeof input.secretKey === 'string' && input.secretKey.trim() ? input.secretKey.trim() : null
  const secretKeyEncrypted = secretKey ? encrypt(secretKey) : undefined

  const providedEncrypted = secretKeyEncrypted ?? null

  await prisma.$executeRaw`
    INSERT INTO "SalesStripeGatewaySettings" (
      "id",
      "enabled",
      "label",
      "feePercent",
      "feeFixedCents",
      "publishableKey",
      "secretKeyEncrypted",
      "dashboardPaymentDescription",
      "currencies",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      'default',
      ${input.enabled},
      ${input.label},
      ${input.feePercent},
      ${input.feeFixedCents},
      ${publishableKey},
      ${providedEncrypted},
      ${input.dashboardPaymentDescription},
      ${input.currencies},
      NOW(),
      NOW()
    )
    ON CONFLICT ("id") DO UPDATE SET
      "enabled" = EXCLUDED."enabled",
      "label" = EXCLUDED."label",
      "feePercent" = EXCLUDED."feePercent",
      "feeFixedCents" = EXCLUDED."feeFixedCents",
      "publishableKey" = EXCLUDED."publishableKey",
      "secretKeyEncrypted" = COALESCE(EXCLUDED."secretKeyEncrypted", "SalesStripeGatewaySettings"."secretKeyEncrypted"),
      "dashboardPaymentDescription" = EXCLUDED."dashboardPaymentDescription",
      "currencies" = EXCLUDED."currencies",
      "updatedAt" = NOW()
  `

  const next = await getStripeGatewaySettings()

  return NextResponse.json({
    ok: true,
    enabled: next.enabled,
    label: next.label,
    feePercent: next.feePercent,
    feeFixedCents: next.feeFixedCents,
    publishableKey: next.publishableKey,
    dashboardPaymentDescription: next.dashboardPaymentDescription,
    currencies: next.currencies.join(', '),
    hasSecretKey: Boolean(next.secretKey),
    secretKeySource: next.secretKeySource,
  })
}
