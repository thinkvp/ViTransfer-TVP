import { prisma } from '@/lib/db'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'
import type { AccountTaxCode, AccountType, Expense } from '@/lib/accounting/types'

// Read-only "bank lines" for the Expenses list: spending posted straight from a bank
// transaction without an Expense record — split lines on expense/COGS accounts, and
// MANUAL (Transfer) postings to an expense/COGS account. They are already counted in
// the BAS, P&L and ledger from those rows; the Expenses list only shows them, it never
// creates Expense records for them (that would double-count).
//
// Money OUT only. Money in on an expense account (a refund or payout posted as a
// Deposit, or a credit split line) is a deposit, not an expense — as in QuickBooks and
// Xero it's left off this list, though it still reduces the account everywhere else.

export type ExpenseListSortKey = 'date' | 'supplier' | 'description' | 'category' | 'amountExGst' | 'gstAmount' | 'amountIncGst' | 'status'

export interface ExpenseBankLineFilters {
  accountId?: string | null
  search?: string | null
  from?: string | null
  to?: string | null
}

const EXPENSE_ACCOUNT_TYPES: AccountType[] = ['EXPENSE', 'COGS']

/** Amount search shared with the Expense query: a decimal is an exact match, a whole number a dollar prefix. */
function matchesAmountSearch(amountIncGstCents: number, search: string): boolean {
  const cleaned = search.replace(/[$,]/g, '')
  const value = parseFloat(cleaned)
  if (isNaN(value) || value < 0) return false
  if (cleaned.includes('.')) return amountIncGstCents === Math.round(value * 100)
  const base = Math.round(value)
  for (let k = 0; k <= 4; k++) {
    const factor = Math.pow(10, k)
    if (amountIncGstCents >= base * factor * 100 && amountIncGstCents < (base + 1) * factor * 100) return true
  }
  return false
}

export async function loadExpenseBankLines(filters: ExpenseBankLineFilters, taxRatePercent: number): Promise<Expense[]> {
  const date = filters.from && filters.to ? { gte: filters.from, lte: filters.to }
    : filters.from ? { gte: filters.from }
    : filters.to ? { lte: filters.to }
    : undefined
  const accountWhere = { type: { in: EXPENSE_ACCOUNT_TYPES } }
  const accountId = filters.accountId || undefined

  const [splitLines, manualPosts] = await Promise.all([
    prisma.splitLine.findMany({
      where: {
        account: accountWhere,
        amountCents: { lt: 0 },
        ...(accountId ? { accountId } : {}),
        bankTransaction: { status: 'MATCHED', ...(date ? { date } : {}) },
      },
      include: {
        account: { select: { name: true, code: true } },
        bankTransaction: { select: { id: true, date: true, description: true, memo: true, _count: { select: { accountingAttachments: true } } } },
      },
    }),
    prisma.bankTransaction.findMany({
      where: {
        status: 'MATCHED',
        matchType: 'MANUAL',
        amountCents: { lt: 0 },
        account: accountWhere,
        ...(accountId ? { accountId } : {}),
        ...(date ? { date } : {}),
      },
      include: {
        account: { select: { name: true, code: true } },
        _count: { select: { accountingAttachments: true } },
      },
    }),
  ])

  const toRow = (r: {
    id: string; bankSource: 'SPLIT' | 'POSTING'; date: string; description: string; accountId: string
    accountName?: string; accountCode?: string; taxCode: AccountTaxCode; bankAmountCents: number
    bankTransactionId: string; attachmentCount: number; createdAt: Date
  }): Expense => {
    // Bank-statement sign: money out is negative, so negate to the Expense convention.
    const amountIncGst = -r.bankAmountCents
    const amountExGst = amountExcludingGst(amountIncGst, r.taxCode, taxRatePercent)
    return {
      id: r.id,
      date: r.date,
      supplierName: null,
      description: r.description,
      accountId: r.accountId,
      accountName: r.accountName,
      accountCode: r.accountCode,
      taxCode: r.taxCode,
      amountExGst,
      gstAmount: amountIncGst - amountExGst,
      amountIncGst,
      status: 'RECONCILED',
      bankTransactionId: r.bankTransactionId,
      userId: null,
      enteredByName: null,
      notes: null,
      attachments: [],
      linkedTransactionAttachmentCount: r.attachmentCount,
      bankSource: r.bankSource,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.createdAt.toISOString(),
    }
  }

  const rows: Expense[] = [
    ...splitLines.map(sl => toRow({
      id: `split:${sl.id}`,
      bankSource: 'SPLIT',
      date: sl.bankTransaction.date,
      // Same order as the BAS purchase records and the account ledger
      description: sl.description || sl.bankTransaction.memo || sl.bankTransaction.description,
      accountId: sl.accountId,
      accountName: sl.account?.name,
      accountCode: sl.account?.code,
      taxCode: sl.taxCode as AccountTaxCode,
      bankAmountCents: sl.amountCents,
      bankTransactionId: sl.bankTransaction.id,
      attachmentCount: sl.bankTransaction._count.accountingAttachments,
      createdAt: sl.createdAt,
    })),
    ...manualPosts.map(t => toRow({
      id: `bank:${t.id}`,
      bankSource: 'POSTING',
      date: t.date,
      description: t.memo || t.description,
      accountId: t.accountId!,
      accountName: t.account?.name,
      accountCode: t.account?.code,
      taxCode: (t.taxCode ?? 'BAS_EXCLUDED') as AccountTaxCode,
      bankAmountCents: t.amountCents,
      bankTransactionId: t.id,
      attachmentCount: t._count.accountingAttachments,
      createdAt: t.createdAt,
    })),
  ]

  const search = filters.search?.trim()
  if (!search) return rows
  const needle = search.toLowerCase()
  return rows.filter(r => r.description.toLowerCase().includes(needle) || matchesAmountSearch(r.amountIncGst, search))
}

const STATUS_RANK: Record<string, number> = { DRAFT: 0, APPROVED: 1, RECONCILED: 2 }

function sortValue(row: Expense, key: ExpenseListSortKey): string | number | null {
  switch (key) {
    case 'supplier': return row.supplierName
    case 'description': return row.description
    case 'category': return row.accountName ?? null
    case 'amountExGst': return row.amountExGst
    case 'gstAmount': return row.gstAmount
    case 'amountIncGst': return row.amountIncGst
    case 'status': return STATUS_RANK[row.status] ?? 2
    default: return row.date
  }
}

/** Comparator mirroring the Expense query's single-column ORDER BY (Postgres puts NULLs last ascending, first descending). */
export function compareExpenseRows(key: ExpenseListSortKey, dir: 'asc' | 'desc') {
  return (a: Expense, b: Expense): number => {
    const av = sortValue(a, key)
    const bv = sortValue(b, key)
    if (av === bv) return 0
    if (av === null) return dir === 'asc' ? 1 : -1
    if (bv === null) return dir === 'asc' ? -1 : 1
    const cmp = av < bv ? -1 : 1
    return dir === 'asc' ? cmp : -cmp
  }
}

/**
 * Two-pointer merge of two lists that are each already in display order. Unlike
 * re-sorting, it keeps each list's own order, so pages stay consistent even where
 * the database collation and the JS comparator disagree on a tie or casing.
 */
export function mergeSorted<T>(a: T[], b: T[], compare: (x: T, y: T) => number, limit: number): T[] {
  const out: T[] = []
  let i = 0
  let j = 0
  while (out.length < limit && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && compare(a[i], b[j]) <= 0)) out.push(a[i++])
    else out.push(b[j++])
  }
  return out
}
