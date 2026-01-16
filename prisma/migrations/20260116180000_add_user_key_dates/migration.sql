-- Add UserKeyDate model for internal calendar items not tied to a project

CREATE TABLE IF NOT EXISTS "UserKeyDate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,

  "date" TEXT NOT NULL,
  "allDay" BOOLEAN NOT NULL DEFAULT FALSE,
  "startTime" TEXT,
  "finishTime" TEXT,

  "title" TEXT NOT NULL,
  "notes" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Postgres does not support ADD CONSTRAINT IF NOT EXISTS; use a guard for re-runs.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserKeyDate_userId_fkey'
  ) THEN
    ALTER TABLE "UserKeyDate"
      ADD CONSTRAINT "UserKeyDate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "UserKeyDate_userId_idx" ON "UserKeyDate"("userId");
CREATE INDEX IF NOT EXISTS "UserKeyDate_userId_date_idx" ON "UserKeyDate"("userId", "date");
