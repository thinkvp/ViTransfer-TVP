-- Add reminder support to UserKeyDate

ALTER TABLE "UserKeyDate"
  ADD COLUMN "reminderAt" TIMESTAMP(3),
  ADD COLUMN "reminderTargets" JSONB,
  ADD COLUMN "reminderSentAt" TIMESTAMP(3),
  ADD COLUMN "reminderLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "reminderAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reminderLastError" TEXT;

CREATE INDEX "UserKeyDate_reminderAt_idx" ON "UserKeyDate"("reminderAt");
CREATE INDEX "UserKeyDate_reminderSentAt_idx" ON "UserKeyDate"("reminderSentAt");
