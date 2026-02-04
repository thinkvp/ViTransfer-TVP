import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { sendPushNotification } from '@/lib/push-notifications'
import { sendAdminQuoteAcceptedEmail } from '@/lib/email'
import { adminAllPermissions, canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'
import { salesQuoteFromDb } from '@/lib/sales/db-mappers'
import { upsertSalesDocumentShareForDoc } from '@/lib/sales/server-document-share'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type AcceptResult =
  | { ok: true; acceptedNow: boolean; quoteId: string; quoteNumber: string; clientName: string | null; projectTitle: string | null }
  | { ok: false; status: number; error: string }

function acceptOk(payload: Omit<Extract<AcceptResult, { ok: true }>, 'ok'>): AcceptResult {
  return { ok: true as const, ...payload }
}

function acceptErr(status: number, error: string): AcceptResult {
  return { ok: false as const, status, error }
}

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

  const share = await prisma.salesDocumentShare.findFirst({
    where: {
      token,
      type: 'QUOTE',
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { token: true, docId: true, docNumber: true, clientName: true, projectTitle: true },
  }).catch(() => null)

  if (!share) return NextResponse.json({ error: 'Link unavailable' }, { status: 404 })

  const quoteId = String(share.docId || '')
  if (!quoteId) return NextResponse.json({ error: 'Link unavailable' }, { status: 404 })

  const acceptResult: AcceptResult = await (async () => {
    try {
      return await prisma.$transaction(async (tx) => {
        const current = await tx.salesQuote.findUnique({ where: { id: quoteId } }).catch(() => null)
        if (!current) return acceptErr(404, 'Quote not found')

        const currentStatus = String((current as any).status || '').toUpperCase()
        if (currentStatus === 'ACCEPTED') {
          return acceptOk({
            acceptedNow: false,
            quoteId,
            quoteNumber: String((current as any).quoteNumber || share.docNumber || ''),
            clientName: typeof share.clientName === 'string' ? share.clientName : null,
            projectTitle: typeof share.projectTitle === 'string' ? share.projectTitle : null,
          })
        }

        if (currentStatus !== 'OPEN' && currentStatus !== 'SENT') {
          return acceptErr(400, 'Quote cannot be accepted in its current status')
        }

        const nextVersion = Number((current as any).version) + 1
        const updatedCount = await tx.salesQuote.updateMany({
          where: { id: quoteId, status: { in: ['OPEN', 'SENT'] as any } },
          data: { status: 'ACCEPTED' as any, acceptedFromStatus: (current as any).status as any, version: nextVersion },
        })

        if (updatedCount.count !== 1) {
          const now = await tx.salesQuote.findUnique({ where: { id: quoteId } }).catch(() => null)
          const nowStatus = String((now as any)?.status || '').toUpperCase()
          if (nowStatus === 'ACCEPTED') {
            return acceptOk({
              acceptedNow: false,
              quoteId,
              quoteNumber: String((now as any)?.quoteNumber || share.docNumber || ''),
              clientName: typeof share.clientName === 'string' ? share.clientName : null,
              projectTitle: typeof share.projectTitle === 'string' ? share.projectTitle : null,
            })
          }
          return acceptErr(400, 'Quote cannot be accepted in its current status')
        }

      const updated = await tx.salesQuote.findUnique({ where: { id: quoteId } }).catch(() => null)
      if (!updated) return acceptErr(500, 'Unable to accept quote')

      const doc = salesQuoteFromDb(updated as any)

        await tx.salesQuoteRevision.create({
          data: {
            quoteId,
            version: Number((updated as any).version) || nextVersion,
            docJson: doc as any,
            createdByUserId: null,
          },
        }).catch(() => null)

        // Keep the public share snapshot in sync with canonical status.
        try {
          await upsertSalesDocumentShareForDoc(tx as any, {
            type: 'QUOTE',
            doc,
            clientId: String((updated as any).clientId || ''),
            projectId: (updated as any).projectId ?? null,
            quoteValidUntilYmd: (updated as any).validUntil ?? null,
          })
        } catch {
          // best-effort
        }

        return acceptOk({
          acceptedNow: true,
          quoteId,
          quoteNumber: String((updated as any).quoteNumber || share.docNumber || ''),
          clientName: typeof share.clientName === 'string' ? share.clientName : null,
          projectTitle: typeof share.projectTitle === 'string' ? share.projectTitle : null,
        })
      })
    } catch {
      return acceptErr(500, 'Unable to accept quote')
    }
  })()

  if (!acceptResult.ok) {
    return NextResponse.json({ error: acceptResult.error }, { status: acceptResult.status })
  }

  // Kick off best-effort notifications without blocking the response.
  if (acceptResult.acceptedNow) {
    const quoteNumber = acceptResult.quoteNumber
    const clientName = acceptResult.clientName ?? undefined
    const quoteIdForLinks = acceptResult.quoteId

    setTimeout(() => {
      void (async () => {
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
              salesQuoteId: quoteIdForLinks,
              __link: { href: `/admin/sales/quotes/${encodeURIComponent(quoteIdForLinks)}` },
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
          const adminQuoteUrl = appDomain
            ? `${appDomain.replace(/\/$/, '')}/admin/sales/quotes/${encodeURIComponent(quoteIdForLinks)}`
            : null

          if (adminEmails.length > 0) {
            await sendAdminQuoteAcceptedEmail({
              adminEmails,
              quoteNumber: quoteNumber || null,
              clientName: clientName || null,
              projectTitle: acceptResult.projectTitle ?? null,
              acceptedAtYmd: new Date().toISOString().slice(0, 10),
              publicQuoteUrl,
              adminQuoteUrl,
            })
          }
        } catch {
          // best-effort
        }
      })().catch(() => {})
    }, 0)
  }

  const res = NextResponse.json({ ok: true })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
