import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu
  const { token } = await ctx.params

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
      take: 200,
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
      take: 200,
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
