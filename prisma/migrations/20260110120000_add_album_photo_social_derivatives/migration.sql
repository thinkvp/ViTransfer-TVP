-- Add social-size derivative fields for album photos

-- Create enum for social derivative status
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AlbumPhotoSocialStatus') THEN
    CREATE TYPE "AlbumPhotoSocialStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'ERROR');
  END IF;
END $$;

ALTER TABLE "AlbumPhoto" ADD COLUMN IF NOT EXISTS "socialStoragePath" TEXT;
ALTER TABLE "AlbumPhoto" ADD COLUMN IF NOT EXISTS "socialStatus" "AlbumPhotoSocialStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "AlbumPhoto" ADD COLUMN IF NOT EXISTS "socialError" TEXT;
ALTER TABLE "AlbumPhoto" ADD COLUMN IF NOT EXISTS "socialGeneratedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AlbumPhoto_albumId_socialStatus_idx" ON "AlbumPhoto"("albumId", "socialStatus");
