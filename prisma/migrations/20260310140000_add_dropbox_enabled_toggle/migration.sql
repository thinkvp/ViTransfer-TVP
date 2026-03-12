-- AlterTable: Add dropboxEnabled to Video
ALTER TABLE "Video" ADD COLUMN "dropboxEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add dropboxEnabled and upload tracking to VideoAsset
ALTER TABLE "VideoAsset" ADD COLUMN "dropboxEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VideoAsset" ADD COLUMN "dropboxUploadStatus" TEXT;
ALTER TABLE "VideoAsset" ADD COLUMN "dropboxUploadProgress" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "VideoAsset" ADD COLUMN "dropboxUploadError" TEXT;

-- Backfill: Mark existing Dropbox-stored videos as dropboxEnabled
UPDATE "Video" SET "dropboxEnabled" = true WHERE "originalStoragePath" LIKE 'dropbox:%';

-- Backfill: Mark existing Dropbox-stored assets as dropboxEnabled
UPDATE "VideoAsset" SET "dropboxEnabled" = true WHERE "storagePath" LIKE 'dropbox:%';
