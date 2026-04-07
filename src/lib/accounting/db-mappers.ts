import type { Account, Expense, BankAccount, BankImportBatch, BankTransaction, BasPeriod, JournalEntry, SplitLine } from './types'

export function accountFromDb(row: any): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    subType: row.subType ?? null,
    taxCode: row.taxCode,
    description: row.description ?? null,
    isActive: Boolean(row.isActive),
    isSystem: Boolean(row.isSystem),
    parentId: row.parentId ?? null,
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    children: row.children ? row.children.map((c: any) => accountFromDb(c)) : undefined,
  }
}

export function expenseFromDb(row: any): Expense {
  return {
    id: row.id,
    date: row.date,
    supplierName: row.supplierName ?? null,
    description: row.description,
    accountId: row.accountId,
    accountName: row.account?.name ?? undefined,
    accountCode: row.account?.code ?? undefined,
    taxCode: row.taxCode,
    amountExGst: Number(row.amountExGst),
    gstAmount: Number(row.gstAmount),
    amountIncGst: Number(row.amountIncGst),
    receiptPath: row.receiptPath ?? null,
    receiptOriginalName: row.receiptOriginalName ?? null,
    status: row.status,
    bankTransactionId: row.bankTransactionId ?? null,
    userId: row.userId ?? null,
    enteredByName: row.enteredByName ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

export function bankAccountFromDb(row: any): BankAccount {
  return {
    id: row.id,
    name: row.name,
    bankName: row.bankName ?? null,
    bsb: row.bsb ?? null,
    accountNumber: row.accountNumber ?? null,
    currency: row.currency,
    openingBalance: Number(row.openingBalance ?? 0),
    currentBalance: Number(row.currentBalance ?? row.openingBalance ?? 0),
    openingBalanceDate: row.openingBalanceDate ?? null,
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

export function bankImportBatchFromDb(row: any): BankImportBatch {
  return {
    id: row.id,
    bankAccountId: row.bankAccountId,
    bankAccountName: row.bankAccount?.name ?? undefined,
    fileName: row.fileName,
    importedAt: row.importedAt instanceof Date ? row.importedAt.toISOString() : row.importedAt,
    rowCount: Number(row.rowCount ?? 0),
    matchedCount: Number(row.matchedCount ?? 0),
    skippedCount: Number(row.skippedCount ?? 0),
    importedById: row.importedById ?? null,
    importedByName: row.importedByName ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  }
}

export function bankTransactionFromDb(row: any): BankTransaction {
  return {
    id: row.id,
    bankAccountId: row.bankAccountId,
    bankAccountName: row.bankAccount?.name ?? undefined,
    importBatchId: row.importBatchId ?? null,
    date: row.date,
    description: row.description,
    reference: row.reference ?? null,
    amountCents: Number(row.amountCents),
    rawCsv: row.rawCsv ?? null,
    status: row.status,
    matchType: row.matchType ?? null,
    invoicePaymentId: row.invoicePaymentId ?? null,
    memo: row.memo ?? null,
    transactionType: row.transactionType ?? null,
    taxCode: row.taxCode ?? null,
    accountId: row.accountId ?? null,
    accountName: row.account?.name ?? null,
    attachmentPath: row.attachmentPath ?? null,
    attachmentOriginalName: row.attachmentOriginalName ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    expense: row.expense ? expenseFromDb(row.expense) : null,
    invoicePayment: row.invoicePayment
      ? { id: row.invoicePayment.id, amountCents: Number(row.invoicePayment.amountCents), paymentDate: row.invoicePayment.paymentDate, invoiceId: row.invoicePayment.invoiceId ?? null, invoiceNumber: row.invoicePayment.invoice?.invoiceNumber ?? null, clientName: row.invoicePayment.invoice?.client?.name ?? null }
      : null,
    splitLines: row.splitLines ? row.splitLines.map((s: any) => splitLineFromDb(s)) : undefined,
  }
}

export function journalEntryFromDb(row: any): JournalEntry {
  return {
    id: row.id,
    date: row.date,
    accountId: row.accountId,
    accountName: row.account?.name ?? undefined,
    accountCode: row.account?.code ?? undefined,
    description: row.description,
    amountCents: Number(row.amountCents),
    taxCode: row.taxCode,
    reference: row.reference ?? null,
    notes: row.notes ?? null,
    userId: row.userId ?? null,
    enteredByName: row.enteredByName ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

export function splitLineFromDb(row: any): SplitLine {
  return {
    id: row.id,
    bankTransactionId: row.bankTransactionId,
    accountId: row.accountId,
    accountName: row.account?.name ?? undefined,
    accountCode: row.account?.code ?? undefined,
    description: row.description,
    amountCents: Number(row.amountCents),
    taxCode: row.taxCode,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  }
}

export function basPeriodFromDb(row: any): BasPeriod {
  return {
    id: row.id,
    label: row.label,
    startDate: row.startDate,
    endDate: row.endDate,
    quarter: Number(row.quarter),
    financialYear: row.financialYear,
    status: row.status,
    basis: row.basis === 'ACCRUAL' ? 'ACCRUAL' : 'CASH',
    lodgedAt: row.lodgedAt instanceof Date ? row.lodgedAt.toISOString() : (row.lodgedAt ?? null),
    notes: row.notes ?? null,
    g2Override: row.g2Override != null ? Number(row.g2Override) : null,
    g3Override: row.g3Override != null ? Number(row.g3Override) : null,
    calculationJson: row.calculationJson ?? null,
    recordsJson: row.recordsJson ?? null,
    paygWithholdingCents: row.paygWithholdingCents != null ? Number(row.paygWithholdingCents) : null,
    paygInstalmentCents: row.paygInstalmentCents != null ? Number(row.paygInstalmentCents) : null,
    paymentDate: row.paymentDate ?? null,
    paymentAmountCents: row.paymentAmountCents != null ? Number(row.paymentAmountCents) : null,
    paymentNotes: row.paymentNotes ?? null,
    paymentExpenseId: row.paymentExpenseId ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}
