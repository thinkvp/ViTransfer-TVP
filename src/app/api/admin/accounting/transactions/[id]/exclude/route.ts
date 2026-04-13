import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'
import { deleteAccountingFile } from '@/lib/accounting/file-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/accounting/transactions/[id]/exclude
// Marks a transaction as EXCLUDED (to suppress it from the unmatched list — e.g. transfers between own accounts)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-exclude',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      accountingAttachments: { select: { storagePath: true } },
    },
  })

  if (!txn) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  if (txn.status === 'MATCHED') {
    return NextResponse.json({ error: 'Cannot exclude a matched transaction. Unmatch it first.' }, { status: 409 })
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.accountingAttachment.deleteMany({ where: { bankTransactionId: id } })

    return tx.bankTransaction.update({
      where: { id },
      data: { status: 'EXCLUDED' },
      include: {
        bankAccount: { select: { id: true, name: true } },
        expense: { include: { account: true } },
        account: true,
        invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true } },
        accountingAttachments: { orderBy: { uploadedAt: 'asc' } },
      },
    })
  })

  await Promise.all(txn.accountingAttachments.map(a => deleteAccountingFile(a.storagePath).catch(() => {})))

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
