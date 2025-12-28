-- Add storage paths for timeline preview assets

ALTER TABLE "Video"
ADD COLUMN "timelinePreviewVttPath" TEXT,
ADD COLUMN "timelinePreviewSpritesPath" TEXT;
