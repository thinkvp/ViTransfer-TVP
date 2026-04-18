-- Remove expense-based BAS payment columns (paymentExpenseId from baseline, paymentPaygExpenseId from 20260418000001)
DROP INDEX IF EXISTS "BasPeriod_paymentExpenseId_key";
ALTER TABLE "BasPeriod" DROP COLUMN IF EXISTS "paymentExpenseId";
DROP INDEX IF EXISTS "BasPeriod_paymentPaygExpenseId_key";
ALTER TABLE "BasPeriod" DROP COLUMN IF EXISTS "paymentPaygExpenseId";

-- Add individual payment component columns
ALTER TABLE "BasPeriod" ADD COLUMN IF NOT EXISTS "paymentGstCents" INTEGER;
ALTER TABLE "BasPeriod" ADD COLUMN IF NOT EXISTS "paymentPaygCents" INTEGER;
ALTER TABLE "BasPeriod" ADD COLUMN IF NOT EXISTS "paymentGstAccountId" TEXT;
ALTER TABLE "BasPeriod" ADD COLUMN IF NOT EXISTS "paymentPaygAccountId" TEXT;

-- Add BAS_PAYMENT match type to enum (safe to run even if already present in newer PG versions)
ALTER TYPE "BankTransactionMatchType" ADD VALUE IF NOT EXISTS 'BAS_PAYMENT';

-- Add basPeriodId to BankTransaction for BAS_PAYMENT matching
ALTER TABLE "BankTransaction" ADD COLUMN IF NOT EXISTS "basPeriodId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "BankTransaction_basPeriodId_key" ON "BankTransaction"("basPeriodId");

-- Foreign keys for the new BAS payment split fields
DO $$ BEGIN
  ALTER TABLE "BasPeriod" ADD CONSTRAINT "BasPeriod_paymentGstAccountId_fkey"
    FOREIGN KEY ("paymentGstAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BasPeriod" ADD CONSTRAINT "BasPeriod_paymentPaygAccountId_fkey"
    FOREIGN KEY ("paymentPaygAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_basPeriodId_fkey"
    FOREIGN KEY ("basPeriodId") REFERENCES "BasPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;


