-- Add per-project max data allocation for client comment uploads (MB, 0 = unlimited)
ALTER TABLE "Project" ADD COLUMN "maxClientUploadAllocationMB" INTEGER NOT NULL DEFAULT 1000;
