// Shared TypeScript types for the Accounting module

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'COGS' | 'EXPENSE'
export type AccountTaxCode = 'GST' | 'GST_FREE' | 'BAS_EXCLUDED' | 'INPUT_TAXED'
export type ExpenseStatus = 'DRAFT' | 'APPROVED' | 'RECONCILED'
export type BankTransactionStatus = 'UNMATCHED' | 'MATCHED' | 'EXCLUDED'
export type BankTransactionMatchType = 'INVOICE_PAYMENT' | 'EXPENSE' | 'MANUAL' | 'SPLIT'
export type BasPeriodStatus = 'DRAFT' | 'REVIEWED' | 'LODGED'

export interface Account {
  id: string
  code: string
  name: string
  type: AccountType
  subType: string | null
  taxCode: AccountTaxCode
  description: string | null
  isActive: boolean
  isSystem: boolean
  parentId: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
  // Optional: populated when includeChildren=true
  children?: Account[]
}

export interface Expense {
  id: string
  date: string
  supplierName: string | null
  description: string
  accountId: string
  accountName?: string
  accountCode?: string
  taxCode: AccountTaxCode
  amountExGst: number
  gstAmount: number
  amountIncGst: number
  receiptPath: string | null
  receiptOriginalName: string | null
  status: ExpenseStatus
  bankTransactionId: string | null
  userId: string | null
  enteredByName: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface BankAccount {
  id: string
  name: string
  bankName: string | null
  bsb: string | null
  accountNumber: string | null
  currency: string
  openingBalance: number
  currentBalance: number
  openingBalanceDate: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface BankImportBatch {
  id: string
  bankAccountId: string
  bankAccountName?: string
  fileName: string
  importedAt: string
  rowCount: number
  matchedCount: number
  skippedCount: number
  importedById: string | null
  importedByName: string | null
  createdAt: string
}

export interface BankTransaction {
  id: string
  bankAccountId: string
  bankAccountName?: string
  importBatchId: string | null
  date: string
  description: string
  reference: string | null
  amountCents: number
  rawCsv: Record<string, string> | null
  status: BankTransactionStatus
  matchType: BankTransactionMatchType | null
  invoicePaymentId: string | null
  // Posting fields
  memo: string | null
  transactionType: string | null
  taxCode: AccountTaxCode | null
  accountId: string | null
  accountName?: string | null
  attachmentPath: string | null
  attachmentOriginalName: string | null
  createdAt: string
  updatedAt: string
  // Populated joins
  expense?: Expense | null
  invoicePayment?: { id: string; amountCents: number; paymentDate: string; invoiceId: string | null; invoiceNumber?: string | null; clientName?: string | null } | null
  splitLines?: SplitLine[]
}

export interface BasPeriod {
  id: string
  label: string
  startDate: string
  endDate: string
  quarter: number
  financialYear: string
  status: BasPeriodStatus
  basis: 'CASH' | 'ACCRUAL'
  lodgedAt: string | null
  notes: string | null
  g2Override: number | null
  g3Override: number | null
  createdAt: string
  updatedAt: string
}

// BAS Calculation result
export interface BasCalculation {
  periodId?: string
  basis: 'CASH' | 'ACCRUAL'
  // Sales labels
  g1TotalSalesCents: number       // Total sales (inc GST)
  g2ExportSalesCents: number      // Export sales (GST-free)
  g3OtherGstFreeCents: number     // Other GST-free sales
  // Purchase labels
  g10CapitalPurchasesCents: number // Capital purchases (inc GST)
  g11NonCapitalPurchasesCents: number // Non-capital purchases (inc GST)
  // Calculated totals
  label1ACents: number            // GST on sales
  label1BCents: number            // GST credits on purchases
  netGstCents: number             // 1A - 1B (positive = payable, negative = refund)
  // Issues list (optional — may be returned separately)
  issues?: BasIssue[]
}

export interface BasIssue {
  severity: 'warning' | 'info'
  code: string
  message: string
  count?: number
}

export interface TaxRate {
  id: string
  name: string
  code: string  // AccountTaxCode value
  rate: number  // 0.10 = 10%
  isDefault: boolean
  isActive: boolean
  sortOrder: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

// Profit & Loss report
export interface ProfitLossReport {
  fromDate: string
  toDate: string
  basis: 'CASH' | 'ACCRUAL'
  currency: string
  income: ProfitLossSection[]
  cogs: ProfitLossSection[]
  grossProfitCents: number
  expenses: ProfitLossSection[]
  netProfitCents: number
  totalIncomeCents: number
  totalCogsAndExpensesCents: number
}

export interface ProfitLossSection {
  accountId: string | null
  accountCode: string | null
  accountName: string
  amountCents: number
  isSubtotal?: boolean
}

// Balance sheet
export interface BalanceSheetReport {
  asAt: string
  currency: string
  assets: BalanceSheetSection[]
  totalAssetsCents: number
  liabilities: BalanceSheetSection[]
  totalLiabilitiesCents: number
  equity: BalanceSheetSection[]
  totalEquityCents: number
}

export interface BalanceSheetSection {
  label: string
  amountCents: number
  accountId?: string | null
  accountCode?: string | null
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  ASSET: 'Asset',
  LIABILITY: 'Liability',
  EQUITY: 'Equity',
  INCOME: 'Income',
  COGS: 'Cost of Goods Sold',
  EXPENSE: 'Expense',
}

export const TAX_CODE_LABELS: Record<AccountTaxCode, string> = {
  GST: 'GST (10%)',
  GST_FREE: 'GST Free',
  BAS_EXCLUDED: 'BAS Excluded',
  INPUT_TAXED: 'Input Taxed',
}

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  RECONCILED: 'Reconciled',
}

export const BANK_TRANSACTION_STATUS_LABELS: Record<BankTransactionStatus, string> = {
  UNMATCHED: 'Unmatched',
  MATCHED: 'Matched',
  EXCLUDED: 'Excluded',
}

export const BAS_PERIOD_STATUS_LABELS: Record<BasPeriodStatus, string> = {
  DRAFT: 'Draft',
  REVIEWED: 'Reviewed',
  LODGED: 'Lodged',
}

export interface JournalEntry {
  id: string
  date: string
  accountId: string
  accountName?: string
  accountCode?: string
  description: string
  amountCents: number
  taxCode: AccountTaxCode
  reference: string | null
  notes: string | null
  userId: string | null
  enteredByName: string | null
  createdAt: string
  updatedAt: string
}

export interface SplitLine {
  id: string
  bankTransactionId: string
  accountId: string
  accountName?: string
  accountCode?: string
  description: string
  amountCents: number
  taxCode: AccountTaxCode
  createdAt: string
}
