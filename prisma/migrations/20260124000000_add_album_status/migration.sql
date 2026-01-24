-- Add album-level status (mirrors Video.status usage)

-- CreateEnum
CREATE TYPE "AlbumStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'ERROR');

-- AlterTable
ALTER TABLE "Album" ADD COLUMN "status" "AlbumStatus" NOT NULL DEFAULT 'READY';

-- Indexes
CREATE INDEX "Album_projectId_status_idx" ON "Album"("projectId", "status");
