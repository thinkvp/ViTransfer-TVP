-- Add default BAS payment accounts to AccountingSettings
ALTER TABLE "AccountingSettings" ADD COLUMN "basGstAccountId" TEXT;
ALTER TABLE "AccountingSettings" ADD COLUMN "basPaygAccountId" TEXT;

-- Add PAYG expense split to BasPeriod
ALTER TABLE "BasPeriod" ADD COLUMN "paymentPaygExpenseId" TEXT;
CREATE UNIQUE INDEX "BasPeriod_paymentPaygExpenseId_key" ON "BasPeriod"("paymentPaygExpenseId");
