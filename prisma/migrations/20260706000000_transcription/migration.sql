-- AlterEnum
-- New value must not be referenced in this same migration (Postgres restriction on enum ALTER in txn)
ALTER TYPE "FileRole" ADD VALUE IF NOT EXISTS 'SUBTITLES_VTT';

-- AlterTable
ALTER TABLE "Video" ADD COLUMN "transcriptionStatus" TEXT;
ALTER TABLE "Video" ADD COLUMN "transcriptionError" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "transcriptionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "transcriptionWhisperUrl" TEXT;
ALTER TABLE "Settings" ADD COLUMN "transcriptionWhisperModel" TEXT DEFAULT 'Systran/faster-whisper-large-v3-turbo';
ALTER TABLE "Settings" ADD COLUMN "transcriptionLanguage" TEXT DEFAULT 'en';
