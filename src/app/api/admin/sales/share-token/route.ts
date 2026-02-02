import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { salesInvoiceFromDb, salesQuoteFromDb } from '@/lib/sales/db-mappers'
import { upsertSalesDocumentShareForDoc } from '@/lib/sales/server-document-share'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-sales-share-token',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const url = new URL(request.url)
  const docType = url.searchParams.get('docType')
  const docId = url.searchParams.get('docId')

  if ((docType !== 'QUOTE' && docType !== 'INVOICE') || !docId) {
    return NextResponse.json({ error: 'Invalid query' }, { status: 400 })
  }

  const share = await prisma.salesDocumentShare.findUnique({
    where: {
      type_docId: {
        type: docType,
        docId,
      },
    },
    select: {
      token: true,
      revokedAt: true,
      expiresAt: true,
    },
  })

  // If a share doesn't exist yet (e.g., older records, or a silent upsert failure),
  // create it lazily so Views & Tracking works immediately for admins.
  if (!share) {
    try {
      await prisma.$transaction(async (tx) => {
        if (docType === 'INVOICE') {
          const invoice = await (tx as any).salesInvoice.findUnique({ where: { id: docId } })
          if (!invoice) return
          await upsertSalesDocumentShareForDoc(tx as any, {
            type: 'INVOICE',
            doc: salesInvoiceFromDb(invoice as any),
            clientId: invoice.clientId,
            projectId: invoice.projectId,
          })
          return
        }

        const quote = await (tx as any).salesQuote.findUnique({ where: { id: docId } })
        if (!quote) return
        await upsertSalesDocumentShareForDoc(tx as any, {
          type: 'QUOTE',
          doc: salesQuoteFromDb(quote as any),
          clientId: quote.clientId,
          projectId: quote.projectId,
          quoteValidUntilYmd: quote.validUntil,
        })
      })
    } catch (e) {
      // Best-effort; returning null token preserves existing behaviour.
      console.error('[SALES] Failed to lazily create share token:', e)
    }
  }

  const shareAfter = share
    ? share
    : await prisma.salesDocumentShare.findUnique({
        where: {
          type_docId: {
            type: docType,
            docId,
          },
        },
        select: {
          token: true,
          revokedAt: true,
          expiresAt: true,
        },
      })

  // IMPORTANT: Admin pages still need the token to show historical
  // Views & Tracking, even if the public link has been revoked/expired.
  const now = new Date()
  const isActive = Boolean(shareAfter && !shareAfter.revokedAt && (!shareAfter.expiresAt || shareAfter.expiresAt > now))
  const token = shareAfter?.token ?? null

  const res = NextResponse.json({ token, isActive, revokedAt: shareAfter?.revokedAt ?? null, expiresAt: shareAfter?.expiresAt ?? null })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
