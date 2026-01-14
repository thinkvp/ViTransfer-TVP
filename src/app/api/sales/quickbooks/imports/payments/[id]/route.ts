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

  const item = await (prisma as any).quickBooksPaymentImport.findUnique({
    where: { id },
    select: {
      id: true,
      qboId: true,
      txnDate: true,
      totalAmt: true,
      customerQboId: true,
      customerName: true,
      paymentRefNum: true,
      privateNote: true,
      lastUpdatedTime: true,
      raw: true,
      createdAt: true,
      updatedAt: true,
      appliedInvoices: {
        orderBy: [{ createdAt: 'desc' }],
        select: {
          id: true,
          invoiceQboId: true,
          amount: true,
          invoiceImport: {
            select: {
              id: true,
              qboId: true,
              docNumber: true,
              txnDate: true,
              dueDate: true,
              totalAmt: true,
              balance: true,
              customerQboId: true,
              customerName: true,
              lastUpdatedTime: true,
            },
          },
        },
      },
    },
  })

  if (!item) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const res = NextResponse.json({ item })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
