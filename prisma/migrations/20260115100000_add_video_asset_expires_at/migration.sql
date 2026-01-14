-- Add missing VideoAsset.expiresAt column.
-- Prisma schema expects this column, and API routes select it by default.

ALTER TABLE IF EXISTS "VideoAsset"
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
