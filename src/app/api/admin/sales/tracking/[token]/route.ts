import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'

function parseLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get('limit')
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return 30
  return Math.min(30, Math.max(1, Math.trunc(n)))
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult
  const { token } = await ctx.params

  const limit = parseLimit(new URL(request.url).searchParams)

  const share = await prisma.salesDocumentShare.findUnique({
    where: { token },
    select: {
      token: true,
      type: true,
      docId: true,
      createdAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  })

  if (!share) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const [views, emails] = await Promise.all([
    prisma.salesDocumentViewEvent.findMany({
      where: { shareToken: token },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        ipAddress: true,
        userAgent: true,
      },
    }),
    prisma.salesEmailTracking.findMany({
      where: {
        type: share.type,
        docId: share.docId,
      },
      orderBy: { sentAt: 'desc' },
      take: limit,
      select: {
        id: true,
        token: true,
        sentAt: true,
        openedAt: true,
        recipientEmail: true,
      },
    }),
  ])

  return NextResponse.json({
    share,
    views,
    emails,
  })
}
