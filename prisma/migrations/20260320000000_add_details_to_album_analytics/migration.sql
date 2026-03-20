-- Add details column to AlbumAnalytics for tracking download source (e.g. Dropbox)
ALTER TABLE "AlbumAnalytics"
ADD COLUMN "details" JSONB;
