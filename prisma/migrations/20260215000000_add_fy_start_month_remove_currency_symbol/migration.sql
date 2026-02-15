-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 7;

-- AlterTable
ALTER TABLE "SalesSettings" DROP COLUMN "currencySymbol";
