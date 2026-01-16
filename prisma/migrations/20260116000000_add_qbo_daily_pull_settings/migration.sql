-- Add persisted daily pull configuration and last-attempt summary for QuickBooks integration

ALTER TABLE "QuickBooksIntegration"
  ADD COLUMN IF NOT EXISTS "dailyPullEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "dailyPullTime" TEXT NOT NULL DEFAULT '21:00',
  ADD COLUMN IF NOT EXISTS "pullLookbackDays" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS "lastDailyPullAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastDailyPullSucceeded" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "lastDailyPullMessage" TEXT;
