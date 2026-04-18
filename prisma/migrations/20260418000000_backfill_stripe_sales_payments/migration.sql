-- Backfill SalesPayment records (source=STRIPE) for existing SalesInvoiceStripePayment rows.
-- Only creates records where:
--   1. The invoiceDocId matches a real SalesInvoice (excludes orphaned test payments)
--   2. No SalesPayment with source=STRIPE already exists for that checkout session (idempotent)
INSERT INTO "SalesPayment" (
  "id",
  "source",
  "excludeFromInvoiceBalance",
  "paymentDate",
  "amountCents",
  "method",
  "reference",
  "clientId",
  "invoiceId",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'STRIPE'::"SalesPaymentSource",
  true,
  TO_CHAR(sisp."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
  sisp."invoiceAmountCents",
  'Stripe',
  sisp."stripeCheckoutSessionId",
  si."clientId",
  sisp."invoiceDocId",
  sisp."createdAt",
  NOW()
FROM "SalesInvoiceStripePayment" sisp
JOIN "SalesInvoice" si ON si.id = sisp."invoiceDocId"
WHERE NOT EXISTS (
  SELECT 1
  FROM "SalesPayment" sp
  WHERE sp.source = 'STRIPE'::"SalesPaymentSource"
    AND sp.reference = sisp."stripeCheckoutSessionId"
);
