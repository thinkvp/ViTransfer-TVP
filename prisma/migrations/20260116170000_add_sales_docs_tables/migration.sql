-- Add normalized Sales tables (docs/settings/sequences/revisions)

-- Enums
DO $$ BEGIN
  CREATE TYPE "SalesQuoteStatus" AS ENUM ('OPEN','SENT','ACCEPTED','CLOSED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesInvoiceStatus" AS ENUM ('OPEN','SENT','OVERDUE','PARTIALLY_PAID','PAID');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SalesPaymentSource" AS ENUM ('MANUAL','STRIPE','QUICKBOOKS');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Core settings / sequence
CREATE TABLE IF NOT EXISTS "SalesSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "businessName" TEXT NOT NULL DEFAULT '',
  "address" TEXT NOT NULL DEFAULT '',
  "abn" TEXT NOT NULL DEFAULT '',
  "phone" TEXT NOT NULL DEFAULT '',
  "email" TEXT NOT NULL DEFAULT '',
  "website" TEXT NOT NULL DEFAULT '',
  "taxRatePercent" DOUBLE PRECISION NOT NULL DEFAULT 10,
  "defaultQuoteValidDays" INTEGER NOT NULL DEFAULT 14,
  "defaultInvoiceDueDays" INTEGER NOT NULL DEFAULT 7,
  "defaultTerms" TEXT NOT NULL DEFAULT 'Payment due within 7 days unless otherwise agreed.',
  "paymentDetails" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SalesSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesSequence" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "quote" INTEGER NOT NULL DEFAULT 0,
  "invoice" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SalesSequence_pkey" PRIMARY KEY ("id")
);

-- Quotes
CREATE TABLE IF NOT EXISTS "SalesQuote" (
  "id" TEXT NOT NULL,
  "quoteNumber" TEXT NOT NULL,
  "status" "SalesQuoteStatus" NOT NULL DEFAULT 'OPEN',
  "acceptedFromStatus" "SalesQuoteStatus",
  "clientId" TEXT NOT NULL,
  "projectId" TEXT,
  "issueDate" TEXT NOT NULL,
  "validUntil" TEXT,
  "notes" TEXT NOT NULL DEFAULT '',
  "terms" TEXT NOT NULL DEFAULT '',
  "itemsJson" JSONB NOT NULL,
  "sentAt" TIMESTAMPTZ,
  "remindersEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "lastExpiryReminderSentYmd" TEXT,
  "qboId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SalesQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SalesQuote_quoteNumber_key" ON "SalesQuote"("quoteNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "SalesQuote_qboId_key" ON "SalesQuote"("qboId") WHERE "qboId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SalesQuote_clientId_idx" ON "SalesQuote"("clientId");
CREATE INDEX IF NOT EXISTS "SalesQuote_projectId_idx" ON "SalesQuote"("projectId");
CREATE INDEX IF NOT EXISTS "SalesQuote_status_idx" ON "SalesQuote"("status");
CREATE INDEX IF NOT EXISTS "SalesQuote_issueDate_idx" ON "SalesQuote"("issueDate");

ALTER TABLE "SalesQuote" ADD CONSTRAINT "SalesQuote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesQuote" ADD CONSTRAINT "SalesQuote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Quote revisions
CREATE TABLE IF NOT EXISTS "SalesQuoteRevision" (
  "id" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "docJson" JSONB NOT NULL,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SalesQuoteRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SalesQuoteRevision_quoteId_version_key" ON "SalesQuoteRevision"("quoteId", "version");
CREATE INDEX IF NOT EXISTS "SalesQuoteRevision_quoteId_idx" ON "SalesQuoteRevision"("quoteId");
CREATE INDEX IF NOT EXISTS "SalesQuoteRevision_createdByUserId_idx" ON "SalesQuoteRevision"("createdByUserId");

ALTER TABLE "SalesQuoteRevision" ADD CONSTRAINT "SalesQuoteRevision_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "SalesQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesQuoteRevision" ADD CONSTRAINT "SalesQuoteRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Invoices
CREATE TABLE IF NOT EXISTS "SalesInvoice" (
  "id" TEXT NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "status" "SalesInvoiceStatus" NOT NULL DEFAULT 'OPEN',
  "clientId" TEXT NOT NULL,
  "projectId" TEXT,
  "issueDate" TEXT NOT NULL,
  "dueDate" TEXT,
  "notes" TEXT NOT NULL DEFAULT '',
  "terms" TEXT NOT NULL DEFAULT '',
  "itemsJson" JSONB NOT NULL,
  "sentAt" TIMESTAMPTZ,
  "remindersEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "lastOverdueReminderSentYmd" TEXT,
  "qboId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SalesInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SalesInvoice_invoiceNumber_key" ON "SalesInvoice"("invoiceNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "SalesInvoice_qboId_key" ON "SalesInvoice"("qboId") WHERE "qboId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SalesInvoice_clientId_idx" ON "SalesInvoice"("clientId");
CREATE INDEX IF NOT EXISTS "SalesInvoice_projectId_idx" ON "SalesInvoice"("projectId");
CREATE INDEX IF NOT EXISTS "SalesInvoice_status_idx" ON "SalesInvoice"("status");
CREATE INDEX IF NOT EXISTS "SalesInvoice_issueDate_idx" ON "SalesInvoice"("issueDate");
CREATE INDEX IF NOT EXISTS "SalesInvoice_dueDate_idx" ON "SalesInvoice"("dueDate");

ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Invoice revisions
CREATE TABLE IF NOT EXISTS "SalesInvoiceRevision" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "docJson" JSONB NOT NULL,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SalesInvoiceRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SalesInvoiceRevision_invoiceId_version_key" ON "SalesInvoiceRevision"("invoiceId", "version");
CREATE INDEX IF NOT EXISTS "SalesInvoiceRevision_invoiceId_idx" ON "SalesInvoiceRevision"("invoiceId");
CREATE INDEX IF NOT EXISTS "SalesInvoiceRevision_createdByUserId_idx" ON "SalesInvoiceRevision"("createdByUserId");

ALTER TABLE "SalesInvoiceRevision" ADD CONSTRAINT "SalesInvoiceRevision_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesInvoiceRevision" ADD CONSTRAINT "SalesInvoiceRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Payments
CREATE TABLE IF NOT EXISTS "SalesPayment" (
  "id" TEXT NOT NULL,
  "source" "SalesPaymentSource" NOT NULL DEFAULT 'MANUAL',
  "paymentDate" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "method" TEXT NOT NULL DEFAULT '',
  "reference" TEXT NOT NULL DEFAULT '',
  "clientId" TEXT,
  "invoiceId" TEXT,
  "qboId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SalesPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SalesPayment_qboId_key" ON "SalesPayment"("qboId") WHERE "qboId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SalesPayment_paymentDate_idx" ON "SalesPayment"("paymentDate");
CREATE INDEX IF NOT EXISTS "SalesPayment_clientId_idx" ON "SalesPayment"("clientId");
CREATE INDEX IF NOT EXISTS "SalesPayment_invoiceId_idx" ON "SalesPayment"("invoiceId");
CREATE INDEX IF NOT EXISTS "SalesPayment_source_idx" ON "SalesPayment"("source");

ALTER TABLE "SalesPayment" ADD CONSTRAINT "SalesPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesPayment" ADD CONSTRAINT "SalesPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- updatedAt triggers: rely on Prisma @updatedAt at app-level.
