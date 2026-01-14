import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getLimit(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get('limit')
  const n = raw ? Number(raw) : 200
  if (!Number.isFinite(n)) return 200
  return Math.min(Math.max(Math.floor(n), 1), 1000)
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const limit = getLimit(request)

  const items = await (prisma as any).quickBooksEstimateImport.findMany({
    orderBy: [{ lastUpdatedTime: 'desc' }, { updatedAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      qboId: true,
      docNumber: true,
      txnDate: true,
      totalAmt: true,
      customerQboId: true,
      customerName: true,
      lastUpdatedTime: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  const res = NextResponse.json({ items })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
