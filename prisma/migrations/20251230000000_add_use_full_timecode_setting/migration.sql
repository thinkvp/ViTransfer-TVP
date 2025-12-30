-- Add per-project display option for comment time formatting
-- When enabled, the UI can show full timecode (HH:MM:SS:FF / DF) instead of M:SS.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Project' AND column_name = 'useFullTimecode'
  ) THEN
    ALTER TABLE "Project" ADD COLUMN "useFullTimecode" BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;
