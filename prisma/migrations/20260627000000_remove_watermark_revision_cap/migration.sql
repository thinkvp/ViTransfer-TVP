-- Remove the watermark feature, the per-video revision cap, and the timeline-previews toggle.
-- Watermarks and revision caps were dropped entirely. Timeline previews are now always-on,
-- gated only by the per-asset `timelinePreviewsReady` readiness flags (kept).

-- Project: drop watermark, revision-cap, and timeline-toggle columns
ALTER TABLE "Project"
  DROP COLUMN IF EXISTS "enableRevisions",
  DROP COLUMN IF EXISTS "maxRevisions",
  DROP COLUMN IF EXISTS "watermarkEnabled",
  DROP COLUMN IF EXISTS "watermarkText",
  DROP COLUMN IF EXISTS "timelinePreviewsEnabled";

-- Settings: drop the matching global defaults
ALTER TABLE "Settings"
  DROP COLUMN IF EXISTS "defaultWatermarkEnabled",
  DROP COLUMN IF EXISTS "defaultWatermarkText",
  DROP COLUMN IF EXISTS "defaultTimelinePreviewsEnabled";
