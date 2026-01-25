-- Add cached on-disk storage totals for projects
-- This allows list views and dashboards to match the actual usage on the mounted volume.

ALTER TABLE "Project" ADD COLUMN "diskBytes" BIGINT;
