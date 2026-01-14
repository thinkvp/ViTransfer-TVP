import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const { id } = await params

  const item = await (prisma as any).quickBooksInvoiceImport.findUnique({
    where: { id },
  })

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const res = NextResponse.json({ item })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
