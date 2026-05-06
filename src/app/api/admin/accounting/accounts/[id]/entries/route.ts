import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { accountFromDb, expenseFromDb, bankTransactionFromDb, journalEntryFromDb } from '@/lib/accounting/db-mappers'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'
import { listSalesInvoiceIncomeEntries } from '@/lib/accounting/sales-income-allocation'
import { deleteAccountingFile } from '@/lib/accounting/file-storage'
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
  const download = url.searchParams.get('download') === 'true'
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10))
  const pageSize = download ? 100000 : Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '50', 10)))
  const from = url.searchParams.get('from') ?? undefined
  const to = url.searchParams.get('to') ?? undefined
  const sortBy = (url.searchParams.get('sortBy') ?? 'date') as 'date' | 'type' | 'description' | 'ref' | 'amount'
  const sortDir = (url.searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc'

  const account = await prisma.account.findFirst({
    where: id.startsWith('c') && id.length > 20 ? { id } : { code: id },
  })
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  // Include child accounts so a parent account page shows entries from all sub-accounts
  const childAccounts = await prisma.account.findMany({
    where: { parentId: account.id },
    select: { id: true, name: true, code: true },
  })
  const accountIds = [account.id, ...childAccounts.map(c => c.id)]
  const accountIdFilter = accountIds.length > 1 ? { in: accountIds } : account.id

  const dateFilter: { gte?: string; lte?: string } = {}
  if (from) dateFilter.gte = from
  if (to) dateFilter.lte = to

  // For ASSET accounts linked to a bank account, fetch all non-excluded bank transactions
  // coaAccountId column is added by a pending migration; cast to bypass stale Prisma client types
  const linkedBankAccount = account.type === 'ASSET'
    ? await prisma.bankAccount.findFirst({ where: { coaAccountId: account.id } as never })
    : null

  const [expenses, bankTransactions, journalEntries, splitLines, salesInvoiceEntries, settings, linkedBankAccountTxns] = await Promise.all([
    prisma.expense.findMany({
      where: { accountId: accountIdFilter, ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}) },
      include: { account: true },
      orderBy: { date: 'desc' },
    }),
    prisma.bankTransaction.findMany({
      where: {
        accountId: accountIdFilter,
        status: 'MATCHED',
        matchType: { not: 'INVOICE_PAYMENT' },
        ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
      },
      include: { account: true, bankAccount: true, expense: { include: { account: true } } },
      orderBy: { date: 'desc' },
    }),
    prisma.journalEntry.findMany({
      where: { accountId: accountIdFilter, ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}) },
      include: { account: { select: { code: true, name: true } } },
      orderBy: { date: 'desc' },
    }),
    prisma.splitLine.findMany({
      where: {
        accountId: accountIdFilter,
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
    listSalesInvoiceIncomeEntries({ from, to, accountIds }),
    prisma.salesSettings.findUnique({ where: { id: 'default' }, select: { taxRatePercent: true } }),
    linkedBankAccount
      ? prisma.bankTransaction.findMany({
          where: {
            bankAccountId: linkedBankAccount.id,
            status: { not: 'EXCLUDED' },
            ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
          },
          select: { id: true, date: true, description: true, reference: true, amountCents: true, status: true, matchType: true },
          orderBy: { date: 'desc' },
        })
      : Promise.resolve([]),
  ])

  const taxRatePercent = settings?.taxRatePercent ?? 10

  const salesInvoiceIds = [...new Set(salesInvoiceEntries.map(entry => entry.invoiceId))]
  const invoiceLinkedTransactions = salesInvoiceIds.length > 0
    ? await prisma.bankTransaction.findMany({
        where: {
          status: 'MATCHED',
          matchType: 'INVOICE_PAYMENT',
          invoicePayment: { invoiceId: { in: salesInvoiceIds } },
        },
        select: {
          id: true,
          date: true,
          description: true,
          amountCents: true,
          invoicePayment: { select: { invoiceId: true } },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      })
    : []

  const invoiceTransactionsByInvoiceId = invoiceLinkedTransactions.reduce<Record<string, { id: string; date: string; description: string; amountCents: number }[]>>((acc, transaction) => {
    const invoiceId = transaction.invoicePayment?.invoiceId
    if (!invoiceId) return acc
    if (!acc[invoiceId]) acc[invoiceId] = []
    acc[invoiceId].push({
      id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amountCents: Number(transaction.amountCents),
    })
    return acc
  }, {})

  type Entry =
    | { kind: 'expense'; date: string; entry: ReturnType<typeof expenseFromDb> }
    | { kind: 'bankTransaction'; date: string; entry: ReturnType<typeof bankTransactionFromDb> }
    | { kind: 'journal'; date: string; entry: ReturnType<typeof journalEntryFromDb> }
    | { kind: 'salesInvoice'; date: string; entry: { id: string; invoiceId: string; invoiceNumber: string; description: string; amountCents: number; clientName: string | null; labelName: string | null; accountName: string; accountCode: string; linkedBankTransactions: { id: string; date: string; description: string; amountCents: number }[] } }
    | { kind: 'split'; date: string; entry: { id: string; bankTransactionId: string; description: string; amountCents: number; taxCode: string; accountName: string; accountCode: string; bankTransactionDate: string; bankTransactionDescription: string; bankTransactionReference: string | null } }
    | { kind: 'bankAccountTxn'; date: string; entry: { id: string; description: string; reference: string | null; amountCents: number; status: string; matchType: string | null } }

  const isDebitNormal = account.type === 'ASSET' || account.type === 'EXPENSE' || account.type === 'COGS'

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
        accountName: entry.accountName,
        accountCode: entry.accountCode,
        linkedBankTransactions: invoiceTransactionsByInvoiceId[entry.invoiceId] ?? [],
      },
    })),
    ...splitLines.map(s => ({
      kind: 'split' as const,
      date: (s.bankTransaction?.date ?? '') as string,
      entry: {
        id: s.id,
        bankTransactionId: s.bankTransactionId,
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
    ...linkedBankAccountTxns.map(t => ({
      kind: 'bankAccountTxn' as const,
      date: t.date as string,
      entry: {
        id: t.id,
        description: t.description,
        reference: t.reference,
        amountCents: Number(t.amountCents),
        status: t.status,
        matchType: t.matchType,
      },
    })),
  ].sort((a, b) => {
    let r = 0
    switch (sortBy) {
      case 'date':
        r = a.date < b.date ? -1 : a.date > b.date ? 1 : 0
        break
      case 'type':
        r = a.kind.localeCompare(b.kind)
        break
      case 'description': {
        const getDesc = (row: typeof a) => { const e = row.entry as any; if (row.kind === 'salesInvoice') return `${e.invoiceNumber ?? ''} ${e.description ?? ''}`; return e.description ?? e.bankTransactionDescription ?? '' }
        r = getDesc(a).localeCompare(getDesc(b))
        break
      }
      case 'ref': {
        const getRef = (row: typeof a) => { const e = row.entry as any; if (row.kind === 'expense') return e.supplierName ?? ''; if (row.kind === 'salesInvoice') return e.labelName ?? e.clientName ?? ''; return e.reference ?? e.bankTransactionReference ?? '' }
        r = getRef(a).localeCompare(getRef(b))
        break
      }
      case 'amount': {
        const getAmt = (row: typeof a): number => { const e = row.entry as any; if (row.kind === 'expense') return e.amountExGst ?? 0; if (row.kind === 'bankTransaction') { const ex = amountExcludingGst(e.amountCents, e.taxCode, taxRatePercent); return isDebitNormal ? -ex : ex } if (row.kind === 'journal') return amountExcludingGst(e.amountCents, e.taxCode, taxRatePercent); if (row.kind === 'split') { const ex = amountExcludingGst(e.amountCents, e.taxCode, taxRatePercent); return isDebitNormal ? -ex : ex } return e.amountCents ?? 0 }
        r = getAmt(a) - getAmt(b)
        break
      }
    }
    return sortDir === 'asc' ? r : -r
  })

  // Sum all entry amounts for the period (across all pages)
  // For debit-normal accounts (ASSET, EXPENSE, COGS), bank transaction and split line
  // amounts must be negated: a credit (positive, money in) reduces the account balance.
  const periodTotalCents = combined.reduce((sum, row) => {
    if (row.kind === 'expense') return sum + (row.entry as ReturnType<typeof expenseFromDb>).amountExGst
    if (row.kind === 'bankTransaction') {
      const t = row.entry as ReturnType<typeof bankTransactionFromDb>
      const exGst = amountExcludingGst(t.amountCents, t.taxCode, taxRatePercent)
      return sum + (isDebitNormal ? -exGst : exGst)
    }
    if (row.kind === 'journal') {
      const j = row.entry as ReturnType<typeof journalEntryFromDb>
      return sum + amountExcludingGst(j.amountCents, j.taxCode, taxRatePercent)
    }
    if (row.kind === 'split') {
      const s = row.entry as { amountCents: number; taxCode: 'GST' | 'GST_FREE' | 'BAS_EXCLUDED' | 'INPUT_TAXED' }
      const exGst = amountExcludingGst(s.amountCents, s.taxCode, taxRatePercent)
      return sum + (isDebitNormal ? -exGst : exGst)
    }
    if (row.kind === 'bankAccountTxn') {
      // Raw cash movement — ASSET account balance tracks actual cash (no GST strip, no sign flip)
      return sum + (row.entry as { amountCents: number }).amountCents
    }
    return sum + (row.entry as { amountCents: number }).amountCents
  }, 0)

  // Apply search filter (affects count/pagination but not period total)
  const q = url.searchParams.get('q')?.toLowerCase().trim() ?? ''
  const qMatch = q.replace(/^\$/, '')  // strip leading $ to support amount searches like "$12.50"
  const searchFiltered = q
    ? combined.filter(entry => {
        const fields: (string | null | undefined)[] = []
        if (entry.kind === 'expense') { const e = entry.entry as { description: string; supplierName?: string | null; amountExGst: number }; fields.push(e.description, e.supplierName, (Math.abs(e.amountExGst) / 100).toFixed(2)) }
        else if (entry.kind === 'bankTransaction') { const t = entry.entry as { description: string; reference?: string | null; amountCents: number }; fields.push(t.description, t.reference, (Math.abs(t.amountCents) / 100).toFixed(2)) }
        else if (entry.kind === 'journal') { const j = entry.entry as { description: string; reference?: string | null; amountCents: number }; fields.push(j.description, j.reference, (Math.abs(j.amountCents) / 100).toFixed(2)) }
        else if (entry.kind === 'salesInvoice') { const s = entry.entry as { invoiceNumber: string; description: string; clientName?: string | null; amountCents: number }; fields.push(s.invoiceNumber, s.description, s.clientName, (Math.abs(s.amountCents) / 100).toFixed(2)) }
        else if (entry.kind === 'bankAccountTxn') { const t = entry.entry as { description: string; reference?: string | null; amountCents: number }; fields.push(t.description, t.reference, (Math.abs(t.amountCents) / 100).toFixed(2)) }
        else { const s = entry.entry as { description: string; bankTransactionDescription: string; bankTransactionReference?: string | null; amountCents: number }; fields.push(s.description, s.bankTransactionDescription, s.bankTransactionReference, (Math.abs(s.amountCents) / 100).toFixed(2)) }
        return fields.some(f => f?.toLowerCase().includes(qMatch))
      })
    : combined

  const total = searchFiltered.length
  const offset = (page - 1) * pageSize
  const slice = searchFiltered.slice(offset, offset + pageSize)

  const res = NextResponse.json({
    account: accountFromDb(account),
    hasChildAccounts: childAccounts.length > 0,
    entries: slice,
    total,
    periodTotalCents,
    taxRatePercent,
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
      select: { id: true, accountId: true, bankTransactionId: true, accountingAttachments: { select: { storagePath: true } } },
    })
    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    if (expense.accountId !== accountId) return NextResponse.json({ error: 'Entry does not belong to this account' }, { status: 403 })

    const attachmentPaths = expense.accountingAttachments.map(a => a.storagePath)
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
    const filesToDelete = [...attachmentPaths]
    await Promise.all(filesToDelete.map(p => deleteAccountingFile(p).catch(() => {})))
    return NextResponse.json({ ok: true })
  }

  // kind === 'bankTransaction': unpost (unmatch) — keep the bank transaction, reset to UNMATCHED
  const txn = await prisma.bankTransaction.findUnique({
    where: { id: entryId },
    include: {
      expense: { select: { id: true, accountingAttachments: { select: { storagePath: true } } } },
      invoicePayment: { select: { id: true, invoiceId: true } },
      accountingAttachments: { select: { id: true, storagePath: true } },
    },
  })
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  if (txn.accountId !== accountId) return NextResponse.json({ error: 'Entry does not belong to this account' }, { status: 403 })
  if (txn.status !== 'MATCHED') return NextResponse.json({ error: 'Transaction is not matched to this account' }, { status: 409 })

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
    // Delete AccountingAttachment records for this transaction (CASCADE won't fire on UPDATE)
    await tx.accountingAttachment.deleteMany({ where: { bankTransactionId: entryId } })
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
      },
    })
  })

  // Delete attachment files after the DB transaction (best-effort)
  const txnFilesToDelete = [
    ...txn.accountingAttachments.map(a => a.storagePath),
  ]
  await Promise.all(txnFilesToDelete.map(p => deleteAccountingFile(p).catch(() => {})))
  if (txn.matchType === 'EXPENSE' && txn.expense) {
    const expFiles = [
      ...(txn.expense.accountingAttachments ?? []).map(a => a.storagePath),
    ]
    await Promise.all(expFiles.map(p => deleteAccountingFile(p).catch(() => {})))
  }

  return NextResponse.json({ ok: true })
}
