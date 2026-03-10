-- Add 480p preview path to Video model
ALTER TABLE "Video" ADD COLUMN "preview480Path" TEXT;

-- Rename previewResolution to previewResolutions (stores JSON array of resolutions)
-- First add the new column
ALTER TABLE "Project" ADD COLUMN "previewResolutions" TEXT NOT NULL DEFAULT '["720p"]';
-- Copy existing values as single-element JSON arrays
UPDATE "Project" SET "previewResolutions" = '["' || "previewResolution" || '"]';
-- Drop the old column
ALTER TABLE "Project" DROP COLUMN "previewResolution";

-- Same for Settings
ALTER TABLE "Settings" ADD COLUMN "defaultPreviewResolutions" TEXT DEFAULT '["720p"]';
UPDATE "Settings" SET "defaultPreviewResolutions" = '["' || COALESCE("defaultPreviewResolution", '720p') || '"]';
ALTER TABLE "Settings" DROP COLUMN "defaultPreviewResolution";

-- Add auto-delete previews on close setting
ALTER TABLE "Settings" ADD COLUMN "autoDeletePreviewsOnClose" BOOLEAN NOT NULL DEFAULT false;
