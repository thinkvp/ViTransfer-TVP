-- Add dropboxPath to Video for human-friendly Dropbox folder paths
ALTER TABLE "Video" ADD COLUMN "dropboxPath" TEXT;

-- Add dropboxPath to VideoAsset for human-friendly Dropbox folder paths
ALTER TABLE "VideoAsset" ADD COLUMN "dropboxPath" TEXT;

-- Remove autoDeleteAlbumZipsOnClose setting (functionality removed)
ALTER TABLE "Settings" DROP COLUMN IF EXISTS "autoDeleteAlbumZipsOnClose";
