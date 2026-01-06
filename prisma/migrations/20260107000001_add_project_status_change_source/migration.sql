-- Add source tracking for status change audit entries.

-- Create enum type
CREATE TYPE "ProjectStatusChangeSource" AS ENUM ('ADMIN', 'CLIENT', 'SYSTEM');

-- Add column with default
ALTER TABLE "ProjectStatusChange"
ADD COLUMN "source" "ProjectStatusChangeSource" NOT NULL DEFAULT 'SYSTEM';

-- Backfill existing rows: if there is an actor, treat as ADMIN.
UPDATE "ProjectStatusChange"
SET "source" = 'ADMIN'
WHERE "changedById" IS NOT NULL;
