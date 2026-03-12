-- AlterTable: add Dropbox upload tracking columns to Album for full and social ZIP files
ALTER TABLE "Album" ADD COLUMN "fullZipDropboxStatus" TEXT;
ALTER TABLE "Album" ADD COLUMN "fullZipDropboxProgress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Album" ADD COLUMN "fullZipDropboxError" TEXT;
ALTER TABLE "Album" ADD COLUMN "socialZipDropboxStatus" TEXT;
ALTER TABLE "Album" ADD COLUMN "socialZipDropboxProgress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Album" ADD COLUMN "socialZipDropboxError" TEXT;
