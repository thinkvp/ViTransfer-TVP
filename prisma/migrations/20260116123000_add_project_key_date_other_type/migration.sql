-- Add OTHER option to ProjectKeyDateType enum
-- Safe to re-run (guards against duplicate enum values).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ProjectKeyDateType'
      AND e.enumlabel = 'OTHER'
  ) THEN
    ALTER TYPE "ProjectKeyDateType" ADD VALUE 'OTHER';
  END IF;
END $$;
