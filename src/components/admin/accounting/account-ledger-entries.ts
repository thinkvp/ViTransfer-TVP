import type { Account, AccountTaxCode, Expense, BankTransaction, JournalEntry } from '@/lib/accounting/types'
import { amountExcludingGst } from '@/lib/accounting/gst-amounts'

export type SplitEntry = { id: string; bankTransactionId: string; description: string; amountCents: number; taxCode: AccountTaxCode; accountName: string; accountCode: string; bankTransactionDate: string; bankTransactionDescription: string; bankTransactionReference: string | null }
export type BankAccountTxnEntry = { id: string; description: string; reference: string | null; amountCents: number; status: string; matchType: string | null }
export type SalesInvoiceEntry = {
  id: string
  invoiceId: string
  invoiceNumber: string
  description: string
  amountCents: number
  clientName: string | null
  labelName: string | null
  accountName: string
  accountCode: string
  linkedBankTransactions: { id: string; date: string; description: string; amountCents: number }[]
}

export type AccountLedgerEntry =
  | { kind: 'expense'; date: string; entry: Expense }
  | { kind: 'bankTransaction'; date: string; entry: BankTransaction }
  | { kind: 'journal'; date: string; entry: JournalEntry }
  | { kind: 'salesInvoice'; date: string; entry: SalesInvoiceEntry }
  | { kind: 'split'; date: string; entry: SplitEntry }
  | { kind: 'bankAccountTxn'; date: string; entry: BankAccountTxnEntry }

export function fmtAud(cents: number) {
  const abs = Math.abs(cents)
  return (cents < 0 ? '-' : '') + '$' + (abs / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function isDebitNormalAccountType(accountType: Account['type'] | undefined) {
  return accountType === 'ASSET' || accountType === 'EXPENSE' || accountType === 'COGS'
}

export function getEntryAmountExGst(row: AccountLedgerEntry, accountType: Account['type'] | undefined, taxRatePercent: number) {
  if (row.kind === 'expense') return (row.entry as Expense).amountExGst
  if (row.kind === 'bankTransaction') {
    const t = row.entry as BankTransaction
    const exGst = amountExcludingGst(t.amountCents, t.taxCode, taxRatePercent)
    return isDebitNormalAccountType(accountType) ? -exGst : exGst
  }
  if (row.kind === 'journal') {
    // Journals store accounting convention (positive = debit). For credit-normal
    // accounts (INCOME/LIABILITY/EQUITY) a credit increases the balance, so negate.
    const j = row.entry as JournalEntry
    const exGst = amountExcludingGst(j.amountCents, j.taxCode, taxRatePercent)
    return isDebitNormalAccountType(accountType) ? exGst : -exGst
  }
  if (row.kind === 'salesInvoice') return (row.entry as SalesInvoiceEntry).amountCents
  if (row.kind === 'bankAccountTxn') return (row.entry as BankAccountTxnEntry).amountCents

  const s = row.entry as SplitEntry
  const exGst = amountExcludingGst(s.amountCents, s.taxCode, taxRatePercent)
  return isDebitNormalAccountType(accountType) ? -exGst : exGst
}

/** Row label + badge classes per entry kind, shared by the ledger page and the P&L drill-down modal. */
export const ENTRY_KIND_BADGE: Record<AccountLedgerEntry['kind'], { label: string; className: string }> = {
  expense: { label: 'Expense', className: 'bg-red-500/10 text-red-400' },
  bankTransaction: { label: 'Bank Txn', className: 'bg-blue-500/10 text-blue-400' },
  journal: { label: 'Journal', className: 'bg-purple-500/10 text-purple-400' },
  salesInvoice: { label: 'Sales Invoice', className: 'bg-green-500/10 text-green-400' },
  bankAccountTxn: { label: 'Cash', className: 'bg-sky-500/10 text-sky-400' },
  split: { label: 'Split', className: 'bg-amber-500/10 text-amber-400' },
}

export function getEntryDescription(row: AccountLedgerEntry): string {
  if (row.kind === 'salesInvoice') {
    const s = row.entry as SalesInvoiceEntry
    return `${s.invoiceNumber} - ${s.description}`
  }
  if (row.kind === 'split') {
    const s = row.entry as SplitEntry
    return s.description || s.bankTransactionDescription
  }
  return (row.entry as { description: string }).description
}

export function getEntryReference(row: AccountLedgerEntry): string | null {
  if (row.kind === 'expense') return (row.entry as Expense).supplierName ?? null
  if (row.kind === 'salesInvoice') {
    const s = row.entry as SalesInvoiceEntry
    return s.labelName ?? s.clientName ?? null
  }
  if (row.kind === 'split') return (row.entry as SplitEntry).bankTransactionReference ?? null
  return (row.entry as { reference?: string | null }).reference ?? null
}

export function getEntryDate(row: AccountLedgerEntry): string {
  if (row.kind === 'split') return (row.entry as SplitEntry).bankTransactionDate
  if (row.kind === 'expense') return (row.entry as Expense).date
  if (row.kind === 'bankTransaction') return (row.entry as BankTransaction).date
  if (row.kind === 'journal') return (row.entry as JournalEntry).date
  return row.date
}
