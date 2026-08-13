-- System-wide policy for which file types clients may upload.
-- Stored as JSON string arrays to match the existing defaultPreviewResolutions convention.
ALTER TABLE "Settings" ADD COLUMN "clientUploadCategories" TEXT DEFAULT '["image","video","audio","project","document","font","archive"]';
ALTER TABLE "Settings" ADD COLUMN "clientUploadCustomExtensions" TEXT DEFAULT '[]';
