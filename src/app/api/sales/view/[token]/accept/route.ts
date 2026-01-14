import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { sendPushNotification } from '@/lib/push-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!token) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
  }

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'sales-quote-accept',
    token
  )
  if (rateLimitResult) return rateLimitResult

  // Ensure it exists, isn't revoked/expired, and is a QUOTE.
  const shares = await prisma.$queryRaw<any[]>`
    SELECT *
    FROM "SalesDocumentShare"
    WHERE "token" = ${token}
      AND "type" = 'QUOTE'
      AND "revokedAt" IS NULL
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
    LIMIT 1
  `

  const share = shares?.[0]
  if (!share) {
    return NextResponse.json({ error: 'Link unavailable' }, { status: 404 })
  }

  const doc = (share.docJson ?? {}) as any
  const status = typeof doc?.status === 'string' ? doc.status.toUpperCase() : ''

  if (status === 'ACCEPTED') {
    return NextResponse.json({ ok: true })
  }

  if (status && status !== 'OPEN' && status !== 'SENT') {
    return NextResponse.json({ error: 'Quote cannot be accepted in its current status' }, { status: 400 })
  }

  const nextDoc = {
    ...doc,
    status: 'ACCEPTED',
    acceptedAt: new Date().toISOString(),
  }

  await prisma.salesDocumentShare.update({
    where: { token },
    data: { docJson: nextDoc },
  })

  try {
    const quoteNumber = typeof doc?.quoteNumber === 'string' ? doc.quoteNumber : undefined
    const clientName = typeof share?.clientName === 'string' ? share.clientName : undefined
    const viewUrl = `/sales/view/${encodeURIComponent(token)}`
    const title = quoteNumber ? `Quote accepted: ${quoteNumber}` : 'Quote accepted'
    const message = clientName ? `${clientName} accepted a quote.` : 'A quote was accepted.'

    await sendPushNotification({
      type: 'SALES_QUOTE_ACCEPTED',
      title,
      message,
      details: {
        quoteNumber,
        clientName,
        viewUrl,
      },
    })
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true })
}
