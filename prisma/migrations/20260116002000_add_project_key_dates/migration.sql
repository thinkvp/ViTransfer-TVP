-- Add ProjectKeyDate model for internal scheduling milestones

DO $$ BEGIN
  CREATE TYPE "ProjectKeyDateType" AS ENUM ('PRE_PRODUCTION', 'SHOOTING', 'DUE_DATE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "ProjectKeyDate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,

  "date" TEXT NOT NULL,
  "allDay" BOOLEAN NOT NULL DEFAULT FALSE,
  "startTime" TEXT,
  "finishTime" TEXT,

  "type" "ProjectKeyDateType" NOT NULL,
  "notes" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Postgres does not support ADD CONSTRAINT IF NOT EXISTS; use a guard for re-runs.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProjectKeyDate_projectId_fkey'
  ) THEN
    ALTER TABLE "ProjectKeyDate"
      ADD CONSTRAINT "ProjectKeyDate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "ProjectKeyDate_projectId_idx" ON "ProjectKeyDate"("projectId");
CREATE INDEX IF NOT EXISTS "ProjectKeyDate_projectId_date_idx" ON "ProjectKeyDate"("projectId", "date");
