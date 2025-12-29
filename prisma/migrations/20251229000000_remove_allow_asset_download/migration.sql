-- Remove deprecated allowAssetDownload field from Project table

ALTER TABLE "Project" DROP COLUMN IF EXISTS "allowAssetDownload";
