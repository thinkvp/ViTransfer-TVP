-- Add per-type admin email toggles (all enabled by default)
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "adminEmailProjectApproved" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "adminEmailInternalComments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "adminEmailTaskComments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "adminEmailInvoicePaid" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "adminEmailQuoteAccepted" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "adminEmailProjectKeyDates" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "adminEmailUserKeyDates" BOOLEAN NOT NULL DEFAULT true;

-- Add default client notification schedule for new projects
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "defaultClientNotificationSchedule" TEXT NOT NULL DEFAULT 'HOURLY';
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "defaultClientNotificationTime" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "defaultClientNotificationDay" INTEGER;

-- Add client email toggle
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "clientEmailProjectApproved" BOOLEAN NOT NULL DEFAULT true;

-- Migrate any existing WEEKLY schedules to NONE
UPDATE "Settings" SET "adminNotificationSchedule" = 'NONE' WHERE "adminNotificationSchedule" = 'WEEKLY';
UPDATE "Project" SET "clientNotificationSchedule" = 'NONE' WHERE "clientNotificationSchedule" = 'WEEKLY';
