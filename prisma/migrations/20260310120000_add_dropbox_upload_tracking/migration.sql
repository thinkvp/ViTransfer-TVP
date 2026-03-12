-- AlterTable
ALTER TABLE "Video" ADD COLUMN "dropboxUploadStatus" TEXT;
ALTER TABLE "Video" ADD COLUMN "dropboxUploadProgress" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Video" ADD COLUMN "dropboxUploadError" TEXT;
