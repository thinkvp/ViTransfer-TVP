-- CreateEnum
CREATE TYPE "AlbumPhotoThumbnailStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'ERROR');

-- AlterTable
ALTER TABLE "AlbumPhoto"
ADD COLUMN     "thumbnailError" TEXT,
ADD COLUMN     "thumbnailFileSize" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "thumbnailGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "thumbnailStatus" "AlbumPhotoThumbnailStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "thumbnailStoragePath" TEXT;

-- CreateTable
CREATE TABLE "AlbumThumbnailJob" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "albumName" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "totalPhotos" INTEGER NOT NULL DEFAULT 0,
    "processedPhotos" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "processedBytes" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AlbumThumbnailJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlbumPhoto_albumId_thumbnailStatus_idx" ON "AlbumPhoto"("albumId", "thumbnailStatus");

-- CreateIndex
CREATE INDEX "AlbumThumbnailJob_status_idx" ON "AlbumThumbnailJob"("status");

-- CreateIndex
CREATE INDEX "AlbumThumbnailJob_albumId_idx" ON "AlbumThumbnailJob"("albumId");

-- CreateIndex
CREATE INDEX "AlbumThumbnailJob_projectId_idx" ON "AlbumThumbnailJob"("projectId");