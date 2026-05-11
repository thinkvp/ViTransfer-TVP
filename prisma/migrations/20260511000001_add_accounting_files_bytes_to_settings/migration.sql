-- Add cached accountingFilesBytes column to Settings (reconciled daily by worker)
ALTER TABLE "Settings" ADD COLUMN "accountingFilesBytes" BIGINT NOT NULL DEFAULT 0;
