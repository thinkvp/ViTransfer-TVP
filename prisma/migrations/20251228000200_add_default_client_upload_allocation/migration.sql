-- Add default max allocation (MB) for client comment attachment uploads
ALTER TABLE "Settings"
ADD COLUMN "defaultMaxClientUploadAllocationMB" INTEGER NOT NULL DEFAULT 1000;
