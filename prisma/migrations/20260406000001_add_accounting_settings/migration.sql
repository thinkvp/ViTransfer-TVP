-- Add posting fields to BankTransaction
ALTER TABLE "BankTransaction" ADD COLUMN "memo" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "transactionType" VARCHAR(50);
ALTER TABLE "BankTransaction" ADD COLUMN "taxCode" "AccountTaxCode";
ALTER TABLE "BankTransaction" ADD COLUMN "accountId" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "attachmentPath" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "attachmentOriginalName" VARCHAR(500);

-- Add foreign key from BankTransaction to Account
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "BankTransaction_accountId_idx" ON "BankTransaction"("accountId");

-- CreateTable TaxRate
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaxRate_isActive_idx" ON "TaxRate"("isActive");
CREATE INDEX "TaxRate_sortOrder_idx" ON "TaxRate"("sortOrder");

-- Seed default tax rates
INSERT INTO "TaxRate" ("id", "name", "code", "rate", "isDefault", "isActive", "sortOrder", "createdAt", "updatedAt") VALUES
  ('taxrate-gst',   'GST (10%)',    'GST',          0.10, true,  true, 1, NOW(), NOW()),
  ('taxrate-free',  'GST Free',     'GST_FREE',      0.00, false, true, 2, NOW(), NOW()),
  ('taxrate-excl',  'BAS Excluded', 'BAS_EXCLUDED',  0.00, false, true, 3, NOW(), NOW()),
  ('taxrate-input', 'Input Taxed',  'INPUT_TAXED',   0.00, false, true, 4, NOW(), NOW());
