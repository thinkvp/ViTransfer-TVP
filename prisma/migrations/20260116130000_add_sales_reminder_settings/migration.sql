-- Add per-recipient sales reminder targeting
ALTER TABLE "ClientRecipient"
ADD COLUMN "receiveSalesReminders" BOOLEAN NOT NULL DEFAULT true;

-- Sales reminder settings (DB-backed so the worker can read them)
CREATE TABLE "SalesReminderSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "overdueInvoiceRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
  "overdueInvoiceBusinessDaysAfterDue" INTEGER NOT NULL DEFAULT 3,
  "quoteExpiryRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
  "quoteExpiryBusinessDaysBeforeValidUntil" INTEGER NOT NULL DEFAULT 3,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SalesReminderSettings_pkey" PRIMARY KEY ("id")
);
