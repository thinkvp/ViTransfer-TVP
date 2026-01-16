-- Add Stripe Checkout gateway settings + payment records

CREATE TABLE IF NOT EXISTS "SalesStripeGatewaySettings" (
  "id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "label" TEXT NOT NULL DEFAULT 'Pay by Credit Card (card processing fee applies)',
  "feePercent" DOUBLE PRECISION NOT NULL DEFAULT 1.7,
  "feeFixedCents" INTEGER NOT NULL DEFAULT 30,
  "publishableKey" TEXT,
  "secretKeyEncrypted" TEXT,
  "dashboardPaymentDescription" TEXT NOT NULL DEFAULT 'Payment for Invoice {invoice_number}',
  "currencies" TEXT NOT NULL DEFAULT 'AUD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SalesStripeGatewaySettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesInvoiceStripePayment" (
  "id" TEXT NOT NULL,

  "shareToken" TEXT NOT NULL,
  "invoiceDocId" TEXT NOT NULL,
  "invoiceNumber" TEXT NOT NULL,

  "currency" TEXT NOT NULL,
  "invoiceAmountCents" INTEGER NOT NULL,
  "feeAmountCents" INTEGER NOT NULL,
  "totalAmountCents" INTEGER NOT NULL,

  "stripeCheckoutSessionId" TEXT NOT NULL,
  "stripePaymentIntentId" TEXT,
  "stripeChargeId" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SalesInvoiceStripePayment_pkey" PRIMARY KEY ("id")
);

-- Uniqueness / lookup
CREATE UNIQUE INDEX IF NOT EXISTS "SalesInvoiceStripePayment_stripeCheckoutSessionId_key" ON "SalesInvoiceStripePayment"("stripeCheckoutSessionId");
CREATE INDEX IF NOT EXISTS "SalesInvoiceStripePayment_invoiceDocId_idx" ON "SalesInvoiceStripePayment"("invoiceDocId");
CREATE INDEX IF NOT EXISTS "SalesInvoiceStripePayment_invoiceNumber_idx" ON "SalesInvoiceStripePayment"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "SalesInvoiceStripePayment_shareToken_createdAt_idx" ON "SalesInvoiceStripePayment"("shareToken", "createdAt");
CREATE INDEX IF NOT EXISTS "SalesInvoiceStripePayment_stripePaymentIntentId_idx" ON "SalesInvoiceStripePayment"("stripePaymentIntentId");

-- Foreign key
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'SalesInvoiceStripePayment_shareToken_fkey'
  ) THEN
    ALTER TABLE "SalesInvoiceStripePayment"
      ADD CONSTRAINT "SalesInvoiceStripePayment_shareToken_fkey"
      FOREIGN KEY ("shareToken") REFERENCES "SalesDocumentShare"("token")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
