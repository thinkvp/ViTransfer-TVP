-- AlterTable: add dropboxEnabled flag and Dropbox path storage to Album
ALTER TABLE "Album" ADD COLUMN IF NOT EXISTS "dropboxEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Album" ADD COLUMN IF NOT EXISTS "fullZipDropboxPath" TEXT;
ALTER TABLE "Album" ADD COLUMN IF NOT EXISTS "socialZipDropboxPath" TEXT;
