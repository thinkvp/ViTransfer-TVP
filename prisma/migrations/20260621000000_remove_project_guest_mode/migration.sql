-- Remove project-level Guest Mode (videos-only guest access). The feature has been
-- removed from the application; the video-only "Generate Video Link" feature is unaffected.
ALTER TABLE "Project" DROP COLUMN IF EXISTS "guestMode";
