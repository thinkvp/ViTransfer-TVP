-- Add allowAssetDownload to Project
-- Prisma schema expects this column, but some databases may predate it.

ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "allowAssetDownload" BOOLEAN NOT NULL DEFAULT true;
