-- Add VOID status to SalesInvoiceStatus enum.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block on
-- older PostgreSQL, so this migration intentionally contains a single statement.
ALTER TYPE "SalesInvoiceStatus" ADD VALUE IF NOT EXISTS 'VOID';
