import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const { id } = await params

  const item = await (prisma as any).quickBooksEstimateImport.findUnique({
    where: { id },
  })

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const res = NextResponse.json({ item })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
