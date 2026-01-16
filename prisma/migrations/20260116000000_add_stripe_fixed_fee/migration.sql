-- Add Stripe fixed processing fee (cents)

ALTER TABLE "SalesStripeGatewaySettings"
  ADD COLUMN IF NOT EXISTS "feeFixedCents" INTEGER NOT NULL DEFAULT 30;

-- Backfill in case the column existed but had NULLs somehow
UPDATE "SalesStripeGatewaySettings"
SET "feeFixedCents" = 30
WHERE "feeFixedCents" IS NULL;

-- If the label is still the old default, update it to the new wording
UPDATE "SalesStripeGatewaySettings"
SET "label" = 'Pay by Credit Card (card processing fee applies)'
WHERE "label" = 'Pay by Credit Card (attracts merchant fees of 1.70%)';
