-- Add per-version "Allow approval of video" flag.
-- Default is disabled for new uploads, but we backfill existing rows to preserve current behavior.

ALTER TABLE "Video" ADD COLUMN "allowApproval" BOOLEAN;

-- Backfill existing videos so current installs keep approval behavior unless explicitly disabled.
UPDATE "Video" SET "allowApproval" = true WHERE "allowApproval" IS NULL;

ALTER TABLE "Video" ALTER COLUMN "allowApproval" SET NOT NULL;
ALTER TABLE "Video" ALTER COLUMN "allowApproval" SET DEFAULT false;
