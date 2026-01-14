import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

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

  const now = new Date()
  const token = share && !share.revokedAt && (!share.expiresAt || share.expiresAt > now) ? share.token : null

  const res = NextResponse.json({ token })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
