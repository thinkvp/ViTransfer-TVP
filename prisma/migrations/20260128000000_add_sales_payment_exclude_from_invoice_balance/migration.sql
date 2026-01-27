-- Add a flag to prevent double-counting reconciled/imported payments.
ALTER TABLE "SalesPayment"
  ADD COLUMN "excludeFromInvoiceBalance" BOOLEAN NOT NULL DEFAULT false;
