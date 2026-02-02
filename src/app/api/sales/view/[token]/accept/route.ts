import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { sendPushNotification } from '@/lib/push-notifications'
import { sendAdminQuoteAcceptedEmail } from '@/lib/email'
import { adminAllPermissions, canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'

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

  const quoteNumber = typeof doc?.quoteNumber === 'string'
    ? doc.quoteNumber
    : (typeof share?.docNumber === 'string' ? share.docNumber : undefined)
  const clientName = typeof share?.clientName === 'string' ? share.clientName : undefined

  // Idempotency: only transition to ACCEPTED once.
  const updated = await prisma.$queryRaw<any[]>`
    UPDATE "SalesDocumentShare"
    SET "docJson" = ${nextDoc}::jsonb
    WHERE "token" = ${token}
      AND "type" = 'QUOTE'
      AND "revokedAt" IS NULL
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
      AND COALESCE(UPPER("docJson"->>'status'), '') <> 'ACCEPTED'
    RETURNING "token", "docId", "docNumber", "clientName", "projectTitle"
  `

  if (!updated?.length) {
    // If another request won the race and accepted it first, treat as OK.
    const sharesNow = await prisma.$queryRaw<any[]>`
      SELECT *
      FROM "SalesDocumentShare"
      WHERE "token" = ${token}
        AND "type" = 'QUOTE'
        AND "revokedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
      LIMIT 1
    `
    const shareNow = sharesNow?.[0]
    const docNow = (shareNow?.docJson ?? {}) as any
    const statusNow = typeof docNow?.status === 'string' ? docNow.status.toUpperCase() : ''
    if (statusNow === 'ACCEPTED') {
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'Quote cannot be accepted in its current status' }, { status: 400 })
  }

  const updatedShare = updated[0]

  try {
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
        ...(typeof (updatedShare as any)?.docId === 'string'
          ? {
              salesQuoteId: String((updatedShare as any).docId),
              __link: { href: `/admin/sales/quotes/${encodeURIComponent(String((updatedShare as any).docId))}` },
            }
          : {}),
      },
    })
  } catch {
    // best-effort
  }

  try {
    const users = await prisma.user.findMany({
      select: {
        email: true,
        appRole: { select: { isSystemAdmin: true, permissions: true } },
      },
    })

    const adminEmails = Array.from(new Set(
      (users || [])
        .filter((u: any) => u && typeof u.email === 'string' && u.email.trim())
        .filter((u: any) => {
          const isSystemAdmin = u?.appRole?.isSystemAdmin === true
          const perms = isSystemAdmin ? adminAllPermissions() : normalizeRolePermissions(u?.appRole?.permissions)
          return canSeeMenu(perms, 'sales')
        })
        .map((u: any) => u.email.trim())
        .filter(Boolean)
    ))

    const appDomain = (process.env.APP_DOMAIN || '').trim()
    const publicQuoteUrl = appDomain ? `${appDomain.replace(/\/$/, '')}/sales/view/${encodeURIComponent(token)}` : null
    const docId = typeof updatedShare?.docId === 'string' ? updatedShare.docId : null
    const adminQuoteUrl = (appDomain && docId)
      ? `${appDomain.replace(/\/$/, '')}/admin/sales/quotes/${encodeURIComponent(docId)}`
      : null

    if (adminEmails.length > 0) {
      await sendAdminQuoteAcceptedEmail({
        adminEmails,
        quoteNumber: quoteNumber || (typeof updatedShare?.docNumber === 'string' ? updatedShare.docNumber : null),
        clientName: clientName || (typeof updatedShare?.clientName === 'string' ? updatedShare.clientName : null),
        projectTitle: typeof updatedShare?.projectTitle === 'string' ? updatedShare.projectTitle : null,
        acceptedAtYmd: new Date().toISOString().slice(0, 10),
        publicQuoteUrl,
        adminQuoteUrl,
      })
    }
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true })
}
