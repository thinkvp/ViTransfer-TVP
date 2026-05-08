ALTER TABLE "SalesPayment"
ADD COLUMN "bankTransactionId" TEXT;

ALTER TABLE "SalesPayment"
ADD CONSTRAINT "SalesPayment_bankTransactionId_fkey"
  FOREIGN KEY ("bankTransactionId")
  REFERENCES "BankTransaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SalesPayment_bankTransactionId_idx"
  ON "SalesPayment"("bankTransactionId");
