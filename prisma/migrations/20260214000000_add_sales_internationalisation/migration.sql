-- Add internationalisation fields to SalesSettings
ALTER TABLE "SalesSettings" ADD COLUMN "businessRegistrationLabel" TEXT NOT NULL DEFAULT 'ABN';
ALTER TABLE "SalesSettings" ADD COLUMN "currencySymbol" TEXT NOT NULL DEFAULT '$';
ALTER TABLE "SalesSettings" ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'AUD';

-- Create SalesTaxRate table for configurable tax rates
CREATE TABLE "SalesTaxRate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTaxRate_pkey" PRIMARY KEY ("id")
);

-- Index for ordering
CREATE INDEX "SalesTaxRate_sortOrder_idx" ON "SalesTaxRate"("sortOrder");

-- Seed default tax rates (No Tax and default Tax)
INSERT INTO "SalesTaxRate" ("id", "name", "rate", "isDefault", "sortOrder", "createdAt", "updatedAt")
VALUES
  ('tax-rate-no-tax', 'No Tax', 0, false, 0, NOW(), NOW()),
  ('tax-rate-default', 'Tax', 10, true, 1, NOW(), NOW());
