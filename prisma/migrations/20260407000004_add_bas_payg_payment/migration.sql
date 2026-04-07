-- AlterTable
ALTER TABLE "BasPeriod" ADD COLUMN "paygWithholdingCents" INTEGER;
ALTER TABLE "BasPeriod" ADD COLUMN "paygInstalmentCents" INTEGER;
ALTER TABLE "BasPeriod" ADD COLUMN "paymentDate" TEXT;
ALTER TABLE "BasPeriod" ADD COLUMN "paymentAmountCents" INTEGER;
ALTER TABLE "BasPeriod" ADD COLUMN "paymentNotes" TEXT;
ALTER TABLE "BasPeriod" ADD COLUMN "paymentExpenseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BasPeriod_paymentExpenseId_key" ON "BasPeriod"("paymentExpenseId");

-- AddForeignKey
ALTER TABLE "BasPeriod" ADD CONSTRAINT "BasPeriod_paymentExpenseId_fkey" FOREIGN KEY ("paymentExpenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
