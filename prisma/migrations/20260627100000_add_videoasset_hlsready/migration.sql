-- Add nullable HLS-readiness flag to VideoAsset.
--   NULL  = N/A (asset is not a video)
--   false = video asset that should have an HLS bundle but doesn't (yet/failed)
--   true  = video asset with a ready HLS bundle
-- Mirrors Video.hlsReady, but nullable so non-video assets stay N/A.
ALTER TABLE "VideoAsset" ADD COLUMN "hlsReady" BOOLEAN;

-- Index for the hls-reconcile retry sweep, which scans for hlsReady = false.
CREATE INDEX "VideoAsset_hlsReady_idx" ON "VideoAsset"("hlsReady");
