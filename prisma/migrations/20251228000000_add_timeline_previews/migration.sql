-- Add timeline preview thumbnail settings

ALTER TABLE "Settings" ADD COLUMN "defaultTimelinePreviewsEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Project" ADD COLUMN "timelinePreviewsEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Video" ADD COLUMN "timelinePreviewsReady" BOOLEAN NOT NULL DEFAULT false;
