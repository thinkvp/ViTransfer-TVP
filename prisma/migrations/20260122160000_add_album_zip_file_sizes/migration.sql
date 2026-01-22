-- Track generated album ZIP artifact sizes for storage totals
ALTER TABLE "Album" ADD COLUMN "fullZipFileSize" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Album" ADD COLUMN "socialZipFileSize" BIGINT NOT NULL DEFAULT 0;
