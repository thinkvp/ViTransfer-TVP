-- Convert FolderRenameJob.status and AlbumThumbnailJob.status from plain String
-- to a typed Postgres enum.  Pre-audit queries (run manually if the tables have data):
--   SELECT DISTINCT status FROM "FolderRenameJob";
--   SELECT DISTINCT status FROM "AlbumThumbnailJob";

CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- Drop defaults before altering column type (PostgreSQL cannot auto-cast
-- a string default like 'PENDING' to the new enum type).
ALTER TABLE "FolderRenameJob" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "FolderRenameJob"
  ALTER COLUMN "status" TYPE "JobStatus"
  USING "status"::"JobStatus";
ALTER TABLE "FolderRenameJob" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"JobStatus";

ALTER TABLE "AlbumThumbnailJob" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "AlbumThumbnailJob"
  ALTER COLUMN "status" TYPE "JobStatus"
  USING "status"::"JobStatus";
ALTER TABLE "AlbumThumbnailJob" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"JobStatus";
