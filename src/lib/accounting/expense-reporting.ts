import type { Prisma } from '@prisma/client'

// Basis-aware date handling for Expense records in reports. Expense records are
// the one P&L leg where "incurred" (expense.date) and "paid" (the reconciled
// bank transaction's date) can differ — posted bank transactions and split
// lines are already at the cash date by nature. These helpers mirror the BAS
// engine's audited semantics (src/lib/accounting/gst.ts):
//
// - CASH:    purchases count when PAID — only RECONCILED expenses, dated by the
//            bank transaction that paid them (falling back to the expense date
//            for the defensive reconciled-but-unlinked case).
// - ACCRUAL: APPROVED + RECONCILED expenses by expense date.

export function expenseReportingDateWhere(
  basis: 'CASH' | 'ACCRUAL',
  range: { gte?: string; lte: string }
): Prisma.ExpenseWhereInput {
  return basis === 'CASH'
    ? {
        status: 'RECONCILED',
        OR: [
          { bankTransaction: { date: range } },
          { bankTransactionId: null, date: range },
        ],
      }
    : {
        status: { in: ['APPROVED', 'RECONCILED'] },
        date: range,
      }
}

/** The date an expense is reported under for the given basis (cash = paid date). */
export function expenseReportingDate(
  expense: { date: string; bankTransaction?: { date: string } | null },
  basis: 'CASH' | 'ACCRUAL'
): string {
  return basis === 'CASH' ? expense.bankTransaction?.date ?? expense.date : expense.date
}
