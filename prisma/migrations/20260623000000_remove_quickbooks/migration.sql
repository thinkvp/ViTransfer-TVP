-- Remove the QuickBooks Online integration (pull-only). The QBO import/staging
-- tables are dropped. The inert `qboId` columns on the shared sales models and the
-- `SalesPaymentSource.QUICKBOOKS` enum value are intentionally retained as historical
-- identifiers and are NOT touched by this migration.
--
-- Drop order respects FKs: QuickBooksPaymentAppliedInvoice references both
-- QuickBooksPaymentImport and QuickBooksInvoiceImport, so it is dropped first.
DROP TABLE IF EXISTS "QuickBooksPaymentAppliedInvoice";
DROP TABLE IF EXISTS "QuickBooksPaymentImport";
DROP TABLE IF EXISTS "QuickBooksInvoiceImport";
DROP TABLE IF EXISTS "QuickBooksEstimateImport";
DROP TABLE IF EXISTS "QuickBooksIntegration";
