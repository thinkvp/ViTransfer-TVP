-- Add reminder fields for ProjectKeyDate

ALTER TABLE "ProjectKeyDate"
ADD COLUMN     "reminderAt" TIMESTAMPTZ,
ADD COLUMN     "reminderTargets" JSONB,
ADD COLUMN     "reminderSentAt" TIMESTAMPTZ,
ADD COLUMN     "reminderLastAttemptAt" TIMESTAMPTZ,
ADD COLUMN     "reminderAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reminderLastError" TEXT;

CREATE INDEX IF NOT EXISTS "ProjectKeyDate_reminderAt_idx" ON "ProjectKeyDate"("reminderAt");
CREATE INDEX IF NOT EXISTS "ProjectKeyDate_reminderSentAt_idx" ON "ProjectKeyDate"("reminderSentAt");
