-- Add social derivative file size tracking for album photos
ALTER TABLE "AlbumPhoto" ADD COLUMN "socialFileSize" BIGINT NOT NULL DEFAULT 0;
