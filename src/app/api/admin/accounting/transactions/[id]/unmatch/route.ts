import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'
import { deleteAccountingFile } from '@/lib/accounting/file-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/accounting/transactions/[id]/unmatch
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-unmatch',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      expense: { select: { id: true, accountingAttachments: { select: { storagePath: true } } } },
      invoicePayment: { select: { id: true, invoiceId: true } },
      accountingAttachments: { select: { id: true, storagePath: true } },
    },
  })

  if (!txn) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  if (txn.status !== 'MATCHED' && txn.status !== 'EXCLUDED') {
    return NextResponse.json({ error: 'Transaction is not matched or excluded' }, { status: 409 })
  }

  await prisma.$transaction(async (tx) => {
    // If matched via split: delete all split lines
    if (txn.matchType === 'SPLIT') {
      await tx.splitLine.deleteMany({ where: { bankTransactionId: id } })
    }

    // If matched via expense: delete the expense record
    if (txn.matchType === 'EXPENSE' && txn.expense) {
      await tx.expense.delete({ where: { id: txn.expense.id } })
    }

    // If matched to invoice payment: delete the SalesPayment and recompute invoice status
    if (txn.matchType === 'INVOICE_PAYMENT' && txn.invoicePayment) {
      const invoiceId = txn.invoicePayment.invoiceId
      await tx.salesPayment.delete({ where: { id: txn.invoicePayment.id } })
      if (invoiceId) {
        await recomputeInvoiceStoredStatus(tx as any, invoiceId, { createdByUserId: authResult.id })
      }
    }

    // Delete AccountingAttachment records (CASCADE won't fire on UPDATE, only on DELETE)
    await tx.accountingAttachment.deleteMany({ where: { bankTransactionId: id } })

    await tx.bankTransaction.update({
      where: { id },
      data: {
        status: 'UNMATCHED',
        matchType: null,
        invoicePaymentId: null,
        memo: null,
        transactionType: null,
        taxCode: null,
        accountId: null,
      },
    })
  })

  // Delete files after the DB transaction (best-effort)
  const filesToDelete = [
    ...txn.accountingAttachments.map(a => a.storagePath),
  ]
  await Promise.all(filesToDelete.map(p => deleteAccountingFile(p).catch(() => {})))
  // Delete the expense attachment files if an expense was removed
  if (txn.matchType === 'EXPENSE' && txn.expense) {
    const expenseFiles = [
      ...(txn.expense.accountingAttachments ?? []).map(a => a.storagePath),
    ]
    await Promise.all(expenseFiles.map(p => deleteAccountingFile(p).catch(() => {})))
  }

  const updated = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { id: true, name: true } },
      expense: { include: { account: true } },
      account: true,
      invoicePayment: { select: { id: true, amountCents: true, paymentDate: true, invoiceId: true, invoice: { select: { invoiceNumber: true, clientId: true, client: { select: { name: true } } } } } },
      splitLines: { include: { account: true } },
      accountingAttachments: { orderBy: { uploadedAt: 'asc' } },
    },
  })

  const res = NextResponse.json({ transaction: updated ? bankTransactionFromDb(updated) : null })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
