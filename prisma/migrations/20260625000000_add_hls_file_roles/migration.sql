-- HLS (segmented) playback support.

-- New StoredFile roles: master/variant playlists and the segment directory.
ALTER TYPE "FileRole" ADD VALUE IF NOT EXISTS 'HLS_PLAYLIST';
ALTER TYPE "FileRole" ADD VALUE IF NOT EXISTS 'HLS_SEGMENTS';

-- Readiness flag mirroring timelinePreviewsReady.
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "hlsReady" BOOLEAN NOT NULL DEFAULT false;
