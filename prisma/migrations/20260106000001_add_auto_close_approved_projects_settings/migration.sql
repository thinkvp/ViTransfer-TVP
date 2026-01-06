-- Add global auto-close setting for approved projects
ALTER TABLE "Settings"
  ADD COLUMN "autoCloseApprovedProjectsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoCloseApprovedProjectsAfterDays" INTEGER NOT NULL DEFAULT 7;
