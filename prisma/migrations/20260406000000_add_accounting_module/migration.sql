-- AddEnum: AccountType
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COGS', 'EXPENSE');

-- AddEnum: AccountTaxCode
CREATE TYPE "AccountTaxCode" AS ENUM ('GST', 'GST_FREE', 'BAS_EXCLUDED', 'INPUT_TAXED');

-- AddEnum: ExpenseStatus
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'APPROVED', 'RECONCILED');

-- AddEnum: BankTransactionStatus
CREATE TYPE "BankTransactionStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'EXCLUDED');

-- AddEnum: BankTransactionMatchType
CREATE TYPE "BankTransactionMatchType" AS ENUM ('INVOICE_PAYMENT', 'EXPENSE', 'MANUAL');

-- AddEnum: BasPeriodStatus
CREATE TYPE "BasPeriodStatus" AS ENUM ('DRAFT', 'REVIEWED', 'LODGED');

-- CreateTable: Account (Chart of Accounts)
CREATE TABLE "Account" (
    "id"          TEXT NOT NULL,
    "code"        VARCHAR(20) NOT NULL,
    "name"        VARCHAR(200) NOT NULL,
    "type"        "AccountType" NOT NULL,
    "subType"     VARCHAR(100),
    "taxCode"     "AccountTaxCode" NOT NULL DEFAULT 'GST',
    "description" TEXT,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "isSystem"    BOOLEAN NOT NULL DEFAULT false,
    "parentId"    TEXT,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Expense
CREATE TABLE "Expense" (
    "id"                  TEXT NOT NULL,
    "date"                TEXT NOT NULL,
    "supplierName"        VARCHAR(300) NOT NULL,
    "description"        TEXT NOT NULL,
    "accountId"          TEXT NOT NULL,
    "taxCode"            "AccountTaxCode" NOT NULL DEFAULT 'GST',
    "amountExGst"        INTEGER NOT NULL,
    "gstAmount"          INTEGER NOT NULL,
    "amountIncGst"       INTEGER NOT NULL,
    "receiptPath"        TEXT,
    "receiptOriginalName" VARCHAR(500),
    "status"             "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "bankTransactionId"  TEXT,
    "userId"             TEXT,
    "enteredByName"      VARCHAR(200),
    "notes"              TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BankAccount
CREATE TABLE "BankAccount" (
    "id"                  TEXT NOT NULL,
    "name"                VARCHAR(200) NOT NULL,
    "bankName"            VARCHAR(200),
    "bsb"                 VARCHAR(10),
    "accountNumber"       VARCHAR(30),
    "currency"            VARCHAR(5) NOT NULL DEFAULT 'AUD',
    "openingBalance"      INTEGER NOT NULL DEFAULT 0,
    "openingBalanceDate"  TEXT,
    "isActive"            BOOLEAN NOT NULL DEFAULT true,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BankImportBatch
CREATE TABLE "BankImportBatch" (
    "id"              TEXT NOT NULL,
    "bankAccountId"   TEXT NOT NULL,
    "fileName"        VARCHAR(500) NOT NULL,
    "importedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowCount"        INTEGER NOT NULL DEFAULT 0,
    "matchedCount"    INTEGER NOT NULL DEFAULT 0,
    "skippedCount"    INTEGER NOT NULL DEFAULT 0,
    "importedById"    TEXT,
    "importedByName"  VARCHAR(200),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BankTransaction
CREATE TABLE "BankTransaction" (
    "id"                TEXT NOT NULL,
    "bankAccountId"     TEXT NOT NULL,
    "importBatchId"     TEXT,
    "date"              TEXT NOT NULL,
    "description"       TEXT NOT NULL,
    "reference"         VARCHAR(500),
    "amountCents"       INTEGER NOT NULL,
    "rawCsv"            JSONB,
    "status"            "BankTransactionStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchType"         "BankTransactionMatchType",
    "invoicePaymentId"  TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BasPeriod
CREATE TABLE "BasPeriod" (
    "id"            TEXT NOT NULL,
    "label"         VARCHAR(100) NOT NULL,
    "startDate"     TEXT NOT NULL,
    "endDate"       TEXT NOT NULL,
    "quarter"       INTEGER NOT NULL,
    "financialYear" VARCHAR(20) NOT NULL,
    "status"        "BasPeriodStatus" NOT NULL DEFAULT 'DRAFT',
    "basis"         TEXT NOT NULL DEFAULT 'CASH',
    "lodgedAt"      TIMESTAMP(3),
    "notes"         TEXT,
    "g2Override"    INTEGER,
    "g3Override"    INTEGER,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BasPeriod_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "Account_code_key" ON "Account"("code");
CREATE UNIQUE INDEX "Expense_bankTransactionId_key" ON "Expense"("bankTransactionId");
CREATE UNIQUE INDEX "BankTransaction_invoicePaymentId_key" ON "BankTransaction"("invoicePaymentId");
CREATE UNIQUE INDEX "BasPeriod_financialYear_quarter_key" ON "BasPeriod"("financialYear", "quarter");

-- Indexes: Account
CREATE INDEX "Account_type_idx" ON "Account"("type");
CREATE INDEX "Account_type_isActive_idx" ON "Account"("type", "isActive");
CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");
CREATE INDEX "Account_sortOrder_idx" ON "Account"("sortOrder");
CREATE INDEX "Account_code_idx" ON "Account"("code");

-- Indexes: Expense
CREATE INDEX "Expense_date_idx" ON "Expense"("date");
CREATE INDEX "Expense_accountId_idx" ON "Expense"("accountId");
CREATE INDEX "Expense_status_idx" ON "Expense"("status");
CREATE INDEX "Expense_userId_idx" ON "Expense"("userId");
CREATE INDEX "Expense_bankTransactionId_idx" ON "Expense"("bankTransactionId");

-- Indexes: BankAccount
CREATE INDEX "BankAccount_isActive_idx" ON "BankAccount"("isActive");

-- Indexes: BankImportBatch
CREATE INDEX "BankImportBatch_bankAccountId_idx" ON "BankImportBatch"("bankAccountId");
CREATE INDEX "BankImportBatch_importedAt_idx" ON "BankImportBatch"("importedAt");

-- Indexes: BankTransaction
CREATE INDEX "BankTransaction_bankAccountId_idx" ON "BankTransaction"("bankAccountId");
CREATE INDEX "BankTransaction_date_idx" ON "BankTransaction"("date");
CREATE INDEX "BankTransaction_status_idx" ON "BankTransaction"("status");
CREATE INDEX "BankTransaction_importBatchId_idx" ON "BankTransaction"("importBatchId");
CREATE INDEX "BankTransaction_bankAccountId_date_idx" ON "BankTransaction"("bankAccountId", "date");
CREATE INDEX "BankTransaction_invoicePaymentId_idx" ON "BankTransaction"("invoicePaymentId");

-- Indexes: BasPeriod
CREATE INDEX "BasPeriod_startDate_idx" ON "BasPeriod"("startDate");
CREATE INDEX "BasPeriod_status_idx" ON "BasPeriod"("status");

-- FK: Account self-reference (parent/children)
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: Expense → Account
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK: Expense → BankTransaction (nullable, set when linked)
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_bankTransactionId_fkey"
    FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: Expense → User
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: BankImportBatch → BankAccount
ALTER TABLE "BankImportBatch" ADD CONSTRAINT "BankImportBatch_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: BankTransaction → BankAccount
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: BankTransaction → BankImportBatch
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_importBatchId_fkey"
    FOREIGN KEY ("importBatchId") REFERENCES "BankImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: BankTransaction → SalesPayment (invoice payment link)
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_invoicePaymentId_fkey"
    FOREIGN KEY ("invoicePaymentId") REFERENCES "SalesPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ======================================================
-- Seed: Default Australian Chart of Accounts
-- ======================================================
INSERT INTO "Account" ("id", "code", "name", "type", "subType", "taxCode", "isSystem", "sortOrder", "createdAt", "updatedAt") VALUES
-- Assets
('acc_asset_bank',    '1-0000', 'Bank Accounts',         'ASSET',     'Bank',                 'BAS_EXCLUDED', true,  10,  NOW(), NOW()),
('acc_asset_ar',      '1-1000', 'Accounts Receivable',   'ASSET',     'Accounts Receivable',  'GST',          true,  20,  NOW(), NOW()),
('acc_asset_other',   '1-9000', 'Other Current Assets',  'ASSET',     'Other',                'BAS_EXCLUDED', false, 30,  NOW(), NOW()),
-- Liabilities
('acc_liab_ap',       '2-0000', 'Accounts Payable',      'LIABILITY', 'Accounts Payable',     'GST',          true,  100, NOW(), NOW()),
('acc_liab_gst',      '2-1000', 'GST Payable',           'LIABILITY', 'Tax Liability',        'BAS_EXCLUDED', true,  110, NOW(), NOW()),
('acc_liab_cc',       '2-2000', 'Credit Cards',          'LIABILITY', 'Credit Card',          'BAS_EXCLUDED', false, 120, NOW(), NOW()),
-- Equity
('acc_equity_oe',     '3-0000', 'Owner''s Equity',       'EQUITY',    'Owner''s Equity',      'BAS_EXCLUDED', true,  200, NOW(), NOW()),
('acc_equity_ret',    '3-1000', 'Retained Earnings',     'EQUITY',    'Retained Earnings',    'BAS_EXCLUDED', false, 210, NOW(), NOW()),
-- Income
('acc_income_sales',  '4-0000', 'Sales Income',          'INCOME',    'Revenue',              'GST',          false, 300, NOW(), NOW()),
('acc_income_other',  '4-1000', 'Other Income',          'INCOME',    'Other Revenue',        'GST',          false, 310, NOW(), NOW()),
-- COGS
('acc_cogs_main',     '5-0000', 'Cost of Goods Sold',    'COGS',      'Cost of Goods Sold',   'GST',          false, 400, NOW(), NOW()),
-- Expenses
('acc_exp_adv',       '6-0000', 'Advertising & Marketing', 'EXPENSE', 'Advertising',          'GST',          false, 500, NOW(), NOW()),
('acc_exp_bank',      '6-1000', 'Bank Charges',          'EXPENSE',   'Bank Charges',         'GST_FREE',     false, 510, NOW(), NOW()),
('acc_exp_motor',     '6-2000', 'Motor Vehicle',         'EXPENSE',   'Motor Vehicle',        'GST',          false, 520, NOW(), NOW()),
('acc_exp_office',    '6-3000', 'Office Supplies',       'EXPENSE',   'Office Supplies',      'GST',          false, 530, NOW(), NOW()),
('acc_exp_software',  '6-4000', 'Software & Subscriptions', 'EXPENSE','Software',             'GST',          false, 540, NOW(), NOW()),
('acc_exp_prof',      '6-5000', 'Professional Services', 'EXPENSE',   'Professional Services','GST',          false, 550, NOW(), NOW()),
('acc_exp_travel',    '6-6000', 'Travel & Accommodation','EXPENSE',   'Travel',               'GST',          false, 560, NOW(), NOW()),
('acc_exp_wages',     '6-7000', 'Wages & Salaries',      'EXPENSE',   'Wages',                'BAS_EXCLUDED', false, 570, NOW(), NOW()),
('acc_exp_super',     '6-8000', 'Superannuation',        'EXPENSE',   'Superannuation',       'BAS_EXCLUDED', false, 580, NOW(), NOW()),
('acc_exp_insurance', '6-9000', 'Insurance',             'EXPENSE',   'Insurance',            'GST_FREE',     false, 590, NOW(), NOW()),
('acc_exp_rent',      '6-9100', 'Rent & Lease',          'EXPENSE',   'Rent',                 'GST',          false, 600, NOW(), NOW()),
('acc_exp_phone',     '6-9200', 'Phone & Internet',      'EXPENSE',   'Telecommunications',   'GST',          false, 610, NOW(), NOW()),
('acc_exp_misc',      '6-9900', 'Miscellaneous Expenses','EXPENSE',   'Miscellaneous',        'GST',          false, 620, NOW(), NOW());
