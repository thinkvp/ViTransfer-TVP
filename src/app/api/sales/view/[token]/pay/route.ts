import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { sumLineItemsSubtotal, sumLineItemsTax } from '@/lib/sales/money'
import { formatStripeDashboardDescription, getStripeGatewaySettings } from '@/lib/sales/stripe-gateway'
import { calcStripeGrossUpCents } from '@/lib/sales/stripe-fees'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function safeOriginFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  try {
    return new URL(s).origin
  } catch {
    return null
  }
}

async function resolvePublicOrigin(request: NextRequest): Promise<string> {
  const envOrigin = safeOriginFromUrl(process.env.NEXT_PUBLIC_APP_URL)
  if (envOrigin) return envOrigin

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { appDomain: true },
    })
    const dbOrigin = safeOriginFromUrl(settings?.appDomain)
    if (dbOrigin) return dbOrigin
  } catch {
    // ignore
  }

  const xfProto = request.headers.get('x-forwarded-proto')
  const xfHost = request.headers.get('x-forwarded-host')
  const proto = (xfProto?.split(',')[0]?.trim() || new URL(request.url).protocol.replace(':', '') || 'http')
  const host = (xfHost?.split(',')[0]?.trim() || request.headers.get('host') || new URL(request.url).host)
  return `${proto}://${host}`
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!token) return NextResponse.json({ error: 'Invalid token' }, { status: 400 })

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests. Please slow down.' },
    'sales-invoice-pay',
    token
  )
  if (rateLimitResult) return rateLimitResult

  const gateway = await getStripeGatewaySettings()
  if (!gateway.enabled) return NextResponse.json({ error: 'Payments are not enabled' }, { status: 400 })
  if (!gateway.secretKey) return NextResponse.json({ error: 'Stripe secret key is not configured' }, { status: 500 })

  // Ensure it exists, isn't revoked/expired, and is an INVOICE.
  const shares = await prisma.$queryRaw<any[]>`
    SELECT *
    FROM "SalesDocumentShare"
    WHERE "token" = ${token}
      AND "type" = 'INVOICE'
      AND "revokedAt" IS NULL
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
    LIMIT 1
  `

  const share = shares?.[0]
  if (!share) return NextResponse.json({ error: 'Link unavailable' }, { status: 404 })

  const doc = (share.docJson ?? {}) as any
  const status = typeof doc?.status === 'string' ? doc.status.toUpperCase() : ''
  if (status === 'PAID') return NextResponse.json({ error: 'Invoice is already paid' }, { status: 400 })

  const items = Array.isArray(doc?.items) ? doc.items : []
  const taxRatePercent = Number((share.settingsJson as any)?.taxRatePercent)
  const defaultTaxRate = Number.isFinite(taxRatePercent) ? taxRatePercent : 10

  const subtotalCents = sumLineItemsSubtotal(items)
  const taxCents = sumLineItemsTax(items, defaultTaxRate)
  const invoiceTotalCents = subtotalCents + taxCents

  if (!Number.isFinite(invoiceTotalCents) || invoiceTotalCents <= 0) {
    return NextResponse.json({ error: 'Invoice total is not payable' }, { status: 400 })
  }

  const feePercent = Number.isFinite(gateway.feePercent) ? gateway.feePercent : 0
  const feeFixedCents = Number.isFinite(gateway.feeFixedCents) ? Math.max(0, Math.trunc(gateway.feeFixedCents)) : 0
  const { feeCents, chargeCents } = calcStripeGrossUpCents(invoiceTotalCents, feePercent, feeFixedCents)

  const currency = (gateway.currencies[0] || 'AUD').toLowerCase()

  const invoiceNumber = typeof doc?.invoiceNumber === 'string' ? doc.invoiceNumber : String(share.docNumber || '')
  const description = formatStripeDashboardDescription(gateway.dashboardPaymentDescription, invoiceNumber)

  const origin = await resolvePublicOrigin(request)
  const returnUrl = `${origin}/sales/view/${encodeURIComponent(token)}`

  const stripe = new Stripe(gateway.secretKey, {
    apiVersion: '2023-10-16',
    typescript: true,
  })

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency,
          product_data: {
            name: `Invoice ${invoiceNumber}`,
          },
          unit_amount: invoiceTotalCents,
        },
        quantity: 1,
      },
      ...(feeCents > 0
        ? [
            {
              price_data: {
                currency,
                product_data: {
                  name: `Card processing fee (${feePercent.toFixed(2)}% + ${(currency || 'aud').toUpperCase()} ${(feeFixedCents / 100).toFixed(2)})`,
                },
                unit_amount: feeCents,
              },
              quantity: 1,
            },
          ]
        : []),
    ],
    success_url: `${returnUrl}?payment=success`,
    cancel_url: `${returnUrl}?payment=cancel`,
    payment_intent_data: {
      description,
      metadata: {
        shareToken: token,
        docId: String(share.docId || ''),
        invoiceNumber,
        currency: currency.toUpperCase(),
        invoiceAmountCents: String(invoiceTotalCents),
        feeAmountCents: String(feeCents),
        totalAmountCents: String(chargeCents),
      },
    },
    metadata: {
      shareToken: token,
      docId: String(share.docId || ''),
      invoiceNumber,
      currency: currency.toUpperCase(),
      invoiceAmountCents: String(invoiceTotalCents),
      feeAmountCents: String(feeCents),
      totalAmountCents: String(chargeCents),
    },
  })

  const url = typeof session.url === 'string' ? session.url : null
  if (!url) return NextResponse.json({ error: 'Stripe did not return a checkout URL' }, { status: 500 })

  const res = NextResponse.json({ url })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
