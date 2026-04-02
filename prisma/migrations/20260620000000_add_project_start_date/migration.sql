-- Add optional startDate column to Project
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3);

-- Backfill existing projects: set startDate to createdAt where not already set
UPDATE "Project" SET "startDate" = "createdAt" WHERE "startDate" IS NULL;
