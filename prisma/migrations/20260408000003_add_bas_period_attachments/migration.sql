-- AlterTable: add basPeriodId to AccountingAttachment
ALTER TABLE "AccountingAttachment" ADD COLUMN "basPeriodId" TEXT;

-- AddForeignKey
ALTER TABLE "AccountingAttachment" ADD CONSTRAINT "AccountingAttachment_basPeriodId_fkey"
  FOREIGN KEY ("basPeriodId") REFERENCES "BasPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "AccountingAttachment_basPeriodId_idx" ON "AccountingAttachment"("basPeriodId");
