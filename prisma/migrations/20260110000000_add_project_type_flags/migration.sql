-- Add per-project media type flags
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "enableVideos" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "enablePhotos" BOOLEAN NOT NULL DEFAULT FALSE;

-- If a project already has albums, ensure Photos is enabled.
UPDATE "Project" p
SET "enablePhotos" = TRUE
WHERE EXISTS (
  SELECT 1 FROM "Album" a WHERE a."projectId" = p."id"
);
