-- AlterEnum
-- New value must not be referenced in this same migration (Postgres restriction on enum ALTER in txn)
ALTER TYPE "FileRole" ADD VALUE IF NOT EXISTS 'TRANSCRIPTION_AUDIO';
