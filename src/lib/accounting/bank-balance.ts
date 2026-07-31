import { prisma } from '@/lib/db'

/**
 * Attach the derived balance fields to bank account rows.
 *
 * `currentBalance` is the opening balance plus every non-EXCLUDED transaction, and
 * `pendingTransactionAmount` is the part of that still sitting UNMATCHED. Neither can be
 * derived from a raw row, so `bankAccountFromDb` cannot fill them in — every route that
 * returns a bank account must run its rows through here first, or it will report a
 * balance of zero.
 */
export async function withBankAccountBalances<T extends { id: string; openingBalance: number }>(
  accounts: T[]
): Promise<(T & { currentBalance: number; pendingTransactionAmount: number })[]> {
  if (accounts.length === 0) return []

  const bankAccountIds = accounts.map(a => a.id)
  const [totals, pending] = await Promise.all([
    prisma.bankTransaction.groupBy({
      by: ['bankAccountId'],
      where: { bankAccountId: { in: bankAccountIds }, status: { not: 'EXCLUDED' } },
      _sum: { amountCents: true },
    }),
    prisma.bankTransaction.groupBy({
      by: ['bankAccountId'],
      where: { bankAccountId: { in: bankAccountIds }, status: 'UNMATCHED' },
      _sum: { amountCents: true },
    }),
  ])

  const totalByAccountId = Object.fromEntries(totals.map(r => [r.bankAccountId, r._sum.amountCents ?? 0]))
  const pendingByAccountId = Object.fromEntries(pending.map(r => [r.bankAccountId, r._sum.amountCents ?? 0]))

  return accounts.map(a => ({
    ...a,
    currentBalance: Number(a.openingBalance) + (totalByAccountId[a.id] ?? 0),
    pendingTransactionAmount: pendingByAccountId[a.id] ?? 0,
  }))
}
