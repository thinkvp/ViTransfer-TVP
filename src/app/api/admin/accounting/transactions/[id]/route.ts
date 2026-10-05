import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu, requireApiMenuAction } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { bankTransactionFromDb } from '@/lib/accounting/db-mappers'
import { deleteAccountingFile, moveAccountingFile } from '@/lib/accounting/file-storage'
import { splitGstInclusive } from '@/lib/accounting/gst-amounts'
// ACCOUNTING_ATTACHMENT has no project association.
// eslint-disable-next-line no-restricted-imports
import { getStoredFilePath, getStoredFileRecords, updateStoredFilePath } from '@/lib/stored-file'

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
      basPeriod: { select: { id: true, label: true, quarter: true, financialYear: true } },
    },
  })

  if (!txn) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  const res = NextResponse.json({ transaction: bankTransactionFromDb(txn) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

const editSchema = z.object({
  // Only the non-Expense manual types; switching to/from Expense still means undo + re-post.
  transactionType: z.enum(['Transfer', 'Deposit', 'ReceivePayment']).optional(),
  accountId: z.string().min(1),
  taxCode: z.enum(['GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED']),
  memo: z.string().trim().max(2000).optional().nullable(),
  supplierName: z.string().trim().max(300).optional().nullable(), // EXPENSE postings only
  confirmLodgedPeriod: z.boolean().optional(),
})

// PATCH /api/admin/accounting/transactions/[id]
// Edits a posted transaction in place (account, GST code, memo, supplier) so a correction
// doesn't need Undo + re-post, which deletes the attachments and the linked Expense.
// Only MANUAL (Transfer/Deposit/Receive Payment) and EXPENSE postings are editable; invoice,
// BAS and split matches still go through Undo.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-transaction-edit',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const txn = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { coaAccountId: true } },
      expense: { include: { accountingAttachments: { select: { id: true, originalName: true } } } },
      accountingAttachments: { select: { id: true, originalName: true } },
    },
  })

  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.status !== 'MATCHED') return NextResponse.json({ error: 'Only posted transactions can be edited' }, { status: 409 })
  const expense = txn.matchType === 'EXPENSE' ? txn.expense : null
  if (txn.matchType === 'EXPENSE' && !expense) {
    return NextResponse.json({ error: 'The linked expense is missing. Undo this transaction and post it again.' }, { status: 409 })
  }
  if (!expense && txn.matchType !== 'MANUAL') {
    return NextResponse.json({ error: 'This kind of match can\'t be edited. Undo it and match it again.' }, { status: 409 })
  }

  const body = await request.json().catch(() => null)
  const parsed = editSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  const d = parsed.data

  const account = await prisma.account.findUnique({ where: { id: d.accountId }, select: { id: true, name: true } })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 400 })

  // Same rule as posting: the bank's own CoA account would count the money twice.
  if (txn.bankAccount?.coaAccountId && d.accountId === txn.bankAccount.coaAccountId) {
    return NextResponse.json(
      { error: `"${account.name}" is this bank account's own Chart of Accounts account. Choose the account the money moved to or from.` },
      { status: 400 }
    )
  }

  const accountChanged = d.accountId !== (expense ? expense.accountId : txn.accountId)
  const taxCodeChanged = d.taxCode !== (expense ? expense.taxCode : txn.taxCode)

  // Changing the account or GST code of a transaction inside a lodged BAS quarter alters
  // figures already reported to the ATO. Allowed, but only once the user confirms.
  if ((accountChanged || taxCodeChanged) && !d.confirmLodgedPeriod) {
    const lodged = await prisma.basPeriod.findFirst({
      where: { status: 'LODGED', startDate: { lte: txn.date }, endDate: { gte: txn.date } },
      select: { label: true, quarter: true, financialYear: true },
    })
    if (lodged) {
      return NextResponse.json({
        error: `This transaction falls in a lodged BAS period (${lodged.label || `Q${lodged.quarter} ${lodged.financialYear}`}). Changing its account or GST code will alter lodged figures.`,
        code: 'LODGED_BAS_PERIOD',
      }, { status: 409 })
    }
  }

  const memo = d.memo === undefined ? txn.memo : (d.memo || null)

  if (expense) {
    const taxRatePercent = d.taxCode === 'GST'
      ? (await prisma.salesSettings.findUnique({ where: { id: 'default' }, select: { taxRatePercent: true } }))?.taxRatePercent ?? 10
      : 10
    // The reconciled amount is fixed; only the GST split follows the tax code.
    const { amountExGst, gstAmount } = splitGstInclusive(expense.amountIncGst, d.taxCode, taxRatePercent)
    const memoChanged = memo !== (txn.memo ?? null)
    const supplierName = d.supplierName === undefined ? undefined : (d.supplierName || null)

    await prisma.$transaction([
      prisma.expense.update({
        where: { id: expense.id },
        data: {
          accountId: d.accountId,
          taxCode: d.taxCode,
          amountExGst,
          gstAmount,
          ...(supplierName !== undefined ? { supplierName } : {}),
          // Posting writes the memo into the expense description; keep that in step, but leave
          // an expense matched from the Expenses page alone unless the memo actually changed.
          ...(memoChanged ? { description: memo || txn.description || '' } : {}),
        },
      }),
      prisma.bankTransaction.update({
        where: { id },
        data: {
          memo,
          taxCode: d.taxCode,
          // The Expense owns the account. Also clears any accountId left by the old
          // expense-editor sync, which double-counted in the account ledger.
          accountId: null,
        },
      }),
    ])
  } else {
    await prisma.bankTransaction.update({
      where: { id },
      data: {
        memo,
        taxCode: d.taxCode,
        accountId: d.accountId,
        ...(d.transactionType ? { transactionType: d.transactionType } : {}),
      },
    })
  }

  // Attachments are filed under the account's folder, so follow the new account (best-effort).
  if (accountChanged) {
    const attachments = [...txn.accountingAttachments, ...(expense?.accountingAttachments ?? [])]
    for (const a of attachments) {
      try {
        const storagePath = await getStoredFilePath('ACCOUNTING_ATTACHMENT', a.id, 'ORIGINAL')
        if (!storagePath) continue
        const newPath = await moveAccountingFile(storagePath, txn.date, d.accountId, a.originalName)
        if (newPath !== storagePath) {
          await updateStoredFilePath('ACCOUNTING_ATTACHMENT', a.id, 'ORIGINAL', newPath)
        }
      } catch {
        // Non-fatal: the file stays readable at its old path via StoredFile
      }
    }
  }

  const updated = await prisma.bankTransaction.findUnique({
    where: { id },
    include: {
      bankAccount: { select: { id: true, name: true } },
      expense: { include: { account: true } },
      account: true,
      splitLines: { include: { account: true } },
      accountingAttachments: { orderBy: { uploadedAt: 'asc' } },
    },
  })

  const res = NextResponse.json({ transaction: bankTransactionFromDb(updated!) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
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
      accountingAttachments: { select: { id: true } },
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

  // Delete attachment files via StoredFile
  const attachmentIds = txn.accountingAttachments.map(a => a.id)
  if (attachmentIds.length > 0) {
    const paths = await getStoredFileRecords('ACCOUNTING_ATTACHMENT', attachmentIds, { select: { storagePath: true } })
    await Promise.all(paths.map(p => deleteAccountingFile(p.storagePath).catch(() => {})))
  }

  await prisma.bankTransaction.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
