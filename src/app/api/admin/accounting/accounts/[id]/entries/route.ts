import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { accountFromDb, expenseFromDb, bankTransactionFromDb, journalEntryFromDb } from '@/lib/accounting/db-mappers'
import { listSalesInvoiceIncomeEntries } from '@/lib/accounting/sales-income-allocation'
import { deleteFile } from '@/lib/storage'
import { recomputeInvoiceStoredStatus } from '@/lib/sales/server-invoice-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-account-entries-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const url = new URL(request.url)
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10))
  const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '50', 10)))
  const from = url.searchParams.get('from') ?? undefined
  const to = url.searchParams.get('to') ?? undefined

  const account = await prisma.account.findFirst({
    where: id.startsWith('c') && id.length > 20 ? { id } : { code: id },
  })
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  const dateFilter: { gte?: string; lte?: string } = {}
  if (from) dateFilter.gte = from
  if (to) dateFilter.lte = to

  const [expenses, bankTransactions, journalEntries, splitLines, salesInvoiceEntries] = await Promise.all([
    prisma.expense.findMany({
      where: { accountId: account.id, ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}) },
      include: { account: true },
      orderBy: { date: 'desc' },
    }),
    prisma.bankTransaction.findMany({
      where: {
        accountId: account.id,
        status: 'MATCHED',
        matchType: { not: 'INVOICE_PAYMENT' },
        ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
      },
      include: { account: true, bankAccount: true, expense: { include: { account: true } } },
      orderBy: { date: 'desc' },
    }),
    prisma.journalEntry.findMany({
      where: { accountId: account.id, ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}) },
      include: { account: { select: { code: true, name: true } } },
      orderBy: { date: 'desc' },
    }),
    prisma.splitLine.findMany({
      where: {
        accountId: account.id,
        bankTransaction: {
          status: 'MATCHED',
          ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
        },
      },
      include: {
        account: { select: { code: true, name: true } },
        bankTransaction: { select: { date: true, description: true, reference: true } },
      },
      orderBy: { bankTransaction: { date: 'desc' } },
    }),
    listSalesInvoiceIncomeEntries({ from, to, accountId: account.id }),
  ])

  type Entry =
    | { kind: 'expense'; date: string; entry: ReturnType<typeof expenseFromDb> }
    | { kind: 'bankTransaction'; date: string; entry: ReturnType<typeof bankTransactionFromDb> }
    | { kind: 'journal'; date: string; entry: ReturnType<typeof journalEntryFromDb> }
    | { kind: 'salesInvoice'; date: string; entry: { id: string; invoiceId: string; invoiceNumber: string; description: string; amountCents: number; clientName: string | null; labelName: string | null } }
    | { kind: 'split'; date: string; entry: { id: string; description: string; amountCents: number; taxCode: string; accountName: string; accountCode: string; bankTransactionDate: string; bankTransactionDescription: string; bankTransactionReference: string | null } }

  const combined: Entry[] = [
    ...expenses.map(e => ({ kind: 'expense' as const, date: e.date as string, entry: expenseFromDb(e) })),
    ...bankTransactions.map(t => ({ kind: 'bankTransaction' as const, date: t.date as string, entry: bankTransactionFromDb(t) })),
    ...journalEntries.map(j => ({ kind: 'journal' as const, date: j.date as string, entry: journalEntryFromDb(j) })),
    ...salesInvoiceEntries.map(entry => ({
      kind: 'salesInvoice' as const,
      date: entry.issueDate,
      entry: {
        id: entry.allocationId,
        invoiceId: entry.invoiceId,
        invoiceNumber: entry.invoiceNumber,
        description: entry.itemDescription,
        amountCents: entry.amountCents,
        clientName: entry.clientName,
        labelName: entry.labelName,
      },
    })),
    ...splitLines.map(s => ({
      kind: 'split' as const,
      date: (s.bankTransaction?.date ?? '') as string,
      entry: {
        id: s.id,
        description: s.description || s.bankTransaction?.description || '',
        amountCents: s.amountCents,
        taxCode: s.taxCode,
        accountName: s.account?.name ?? '',
        accountCode: s.account?.code ?? '',
        bankTransactionDate: (s.bankTransaction?.date ?? '') as string,
        bankTransactionDescription: s.bankTransaction?.description ?? '',
        bankTransactionReference: s.bankTransaction?.reference ?? null,
      },
    })),
  ].sort((a, b) => {
    if (b.date < a.date) return -1
    if (b.date > a.date) return 1
    return 0
  })

  const total = combined.length
  const offset = (page - 1) * pageSize
  const slice = combined.slice(offset, offset + pageSize)

  const res = NextResponse.json({
    account: accountFromDb(account),
    entries: slice,
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// DELETE /api/admin/accounting/accounts/[id]/entries?entryId=xxx&kind=expense|bankTransaction
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-account-entries-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id: accountParam } = await params
  const url = new URL(request.url)
  const entryId = url.searchParams.get('entryId')
  const kind = url.searchParams.get('kind')

  if (!entryId || !kind) {
    return NextResponse.json({ error: 'entryId and kind are required' }, { status: 400 })
  }
  if (kind !== 'expense' && kind !== 'bankTransaction' && kind !== 'journal') {
    return NextResponse.json({ error: 'kind must be "expense", "bankTransaction", or "journal"' }, { status: 400 })
  }

  // Resolve the account by id or code
  const account = await prisma.account.findFirst({
    where: accountParam.startsWith('c') && accountParam.length > 20 ? { id: accountParam } : { code: accountParam },
    select: { id: true },
  })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  const accountId = account.id

  if (kind === 'journal') {
    const je = await prisma.journalEntry.findUnique({ where: { id: entryId }, select: { id: true, accountId: true } })
    if (!je) return NextResponse.json({ error: 'Journal entry not found' }, { status: 404 })
    if (je.accountId !== accountId) return NextResponse.json({ error: 'Entry does not belong to this account' }, { status: 403 })
    await prisma.journalEntry.delete({ where: { id: entryId } })
    return NextResponse.json({ ok: true })
  }

  if (kind === 'expense') {
    const expense = await prisma.expense.findUnique({
      where: { id: entryId },
      select: { id: true, accountId: true, receiptPath: true, bankTransactionId: true },
    })
    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    if (expense.accountId !== accountId) return NextResponse.json({ error: 'Entry does not belong to this account' }, { status: 403 })

    const receiptPath = expense.receiptPath
    await prisma.$transaction(async (tx) => {
      // If this expense was linked to a bank transaction, unlink it
      if (expense.bankTransactionId) {
        await tx.bankTransaction.update({
          where: { id: expense.bankTransactionId },
          data: { status: 'UNMATCHED', matchType: null, accountId: null },
        })
      }
      await tx.expense.delete({ where: { id: entryId } })
    })
    if (receiptPath) await deleteFile(receiptPath).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  // kind === 'bankTransaction': unpost (unmatch) — keep the bank transaction, reset to UNMATCHED
  const txn = await prisma.bankTransaction.findUnique({
    where: { id: entryId },
    include: {
      expense: { select: { id: true, receiptPath: true } },
      invoicePayment: { select: { id: true, invoiceId: true } },
    },
  })
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.accountId !== accountId) return NextResponse.json({ error: 'Entry does not belong to this account' }, { status: 403 })
  if (txn.status !== 'MATCHED') return NextResponse.json({ error: 'Transaction is not matched to this account' }, { status: 409 })

  const expenseReceiptPath = txn.matchType === 'EXPENSE' ? (txn.expense?.receiptPath ?? null) : null

  await prisma.$transaction(async (tx) => {
    if (txn.matchType === 'EXPENSE' && txn.expense) {
      await tx.expense.delete({ where: { id: txn.expense.id } })
    }
    if (txn.matchType === 'INVOICE_PAYMENT' && txn.invoicePayment) {
      const invoiceId = txn.invoicePayment.invoiceId
      await tx.salesPayment.delete({ where: { id: txn.invoicePayment.id } })
      if (invoiceId) {
        await recomputeInvoiceStoredStatus(tx as any, invoiceId, { createdByUserId: authResult.id })
      }
    }
    await tx.bankTransaction.update({
      where: { id: entryId },
      data: {
        status: 'UNMATCHED',
        matchType: null,
        invoicePaymentId: null,
        memo: null,
        transactionType: null,
        taxCode: null,
        accountId: null,
        attachmentPath: null,
        attachmentOriginalName: null,
      },
    })
  })

  if (expenseReceiptPath) await deleteFile(expenseReceiptPath).catch(() => {})

  return NextResponse.json({ ok: true })
}
