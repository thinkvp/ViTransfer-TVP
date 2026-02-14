-- AlterTable: per-document taxEnabled (snapshot at creation time)
ALTER TABLE "SalesQuote" ADD COLUMN "taxEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SalesInvoice" ADD COLUMN "taxEnabled" BOOLEAN NOT NULL DEFAULT true;
