-- Per-version opt-out for Whisper auto-generated subtitles (default on).
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "autoGenerateSubtitles" BOOLEAN NOT NULL DEFAULT true;
