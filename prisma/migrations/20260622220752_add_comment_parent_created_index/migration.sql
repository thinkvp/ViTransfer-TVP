-- AlterTable
ALTER TABLE "AccountingSettings" ALTER COLUMN "id" SET DEFAULT 'default',
ALTER COLUMN "reportingBasis" SET DEFAULT 'CASH',
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "JournalEntry" ALTER COLUMN "taxCode" DROP DEFAULT;

-- AlterTable
ALTER TABLE "StoredFile" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TaxRate" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Comment_parentId_createdAt_idx" ON "Comment"("parentId", "createdAt");
