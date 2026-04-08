-- CreateTable: AccountingAttachment
CREATE TABLE "AccountingAttachment" (
    "id" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "originalName" VARCHAR(500) NOT NULL,
    "bankTransactionId" TEXT,
    "expenseId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountingAttachment_bankTransactionId_idx" ON "AccountingAttachment"("bankTransactionId");

-- CreateIndex
CREATE INDEX "AccountingAttachment_expenseId_idx" ON "AccountingAttachment"("expenseId");

-- AddForeignKey
ALTER TABLE "AccountingAttachment" ADD CONSTRAINT "AccountingAttachment_bankTransactionId_fkey"
    FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingAttachment" ADD CONSTRAINT "AccountingAttachment_expenseId_fkey"
    FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
