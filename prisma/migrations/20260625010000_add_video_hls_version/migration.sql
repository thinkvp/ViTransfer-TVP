-- HLS packaging format version. 0 = none/legacy (non-keyframe-aligned, ABR-unsafe);
-- >=1 = keyframe-aligned renditions, eligible for adaptive-bitrate playback.
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "hlsVersion" INTEGER NOT NULL DEFAULT 0;
