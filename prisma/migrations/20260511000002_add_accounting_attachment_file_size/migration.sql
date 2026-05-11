-- Add fileSize column to AccountingAttachment for delta-tracking of accounting storage totals
ALTER TABLE "AccountingAttachment" ADD COLUMN "fileSize" INTEGER NOT NULL DEFAULT 0;
