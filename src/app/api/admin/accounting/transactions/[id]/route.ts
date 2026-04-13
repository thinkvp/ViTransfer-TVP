import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'
import { deleteAccountingFile } from '@/lib/accounting/file-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { id: true, name: true } },
      expense: { include: { account: true } },
      account: true,
      invoicePayment: {
        select: {
          id: true,
          amountCents: true,
          paymentDate: true,
          invoiceId: true,
          invoice: { select: { invoiceNumber: true, client: { select: { name: true } } } },
        },
      },
      splitLines: { include: { account: true } },
      accountingAttachments: { orderBy: { uploadedAt: 'asc' } },
    },
  })

  if (!txn) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  const res = NextResponse.json({ transaction: bankTransactionFromDb(txn) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      accountingAttachments: { select: { id: true, storagePath: true } },
    },
  })

  if (!txn) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  if (txn.status === 'MATCHED') {
    return NextResponse.json(
      { error: 'Cannot delete a matched transaction. Unmatch it first.' },
      { status: 409 }
    )
  }

  // Delete attachment files from disk before removing the DB record (CASCADE handles DB rows)
  const filesToDelete = [
    ...txn.accountingAttachments.map(a => a.storagePath),
  ]
  await Promise.all(filesToDelete.map(p => deleteAccountingFile(p).catch(() => {})))

  await prisma.bankTransaction.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
