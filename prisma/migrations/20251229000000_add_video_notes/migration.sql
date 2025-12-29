-- Add optional Video.videoNotes (max 500 chars)
-- Kept idempotent for safer re-runs / restored backups.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Video' AND column_name = 'videoNotes'
  ) THEN
    ALTER TABLE "Video" ADD COLUMN "videoNotes" VARCHAR(500);
  END IF;
END $$;
