-- Add default income account to SalesSettings
ALTER TABLE "SalesSettings" ADD COLUMN "defaultIncomeAccountId" TEXT;

ALTER TABLE "SalesSettings" ADD CONSTRAINT "SalesSettings_defaultIncomeAccountId_fkey"
  FOREIGN KEY ("defaultIncomeAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
