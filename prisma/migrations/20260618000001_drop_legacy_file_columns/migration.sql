-- Drop the legacy per-entity file path/size columns. Every file reference now lives in the
-- StoredFile registry. This MUST run after 20260618000000_rebackfill_stored_files, which
-- copies any rows still only present in these columns into StoredFile — otherwise files
-- uploaded between the v1.9.7 deploy and this upgrade would be lost.
--
-- DROP COLUMN IF EXISTS keeps this idempotent and safe on databases where the columns were
-- already removed out-of-band (e.g. a dev DB previously synced via `prisma db push`).

ALTER TABLE "User" DROP COLUMN IF EXISTS "avatarPath";

ALTER TABLE "ClientFile"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "storagePath";

ALTER TABLE "UserFile"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "storagePath";

ALTER TABLE "ProjectEmail"
  DROP COLUMN IF EXISTS "rawFileSize",
  DROP COLUMN IF EXISTS "rawStoragePath";

ALTER TABLE "ProjectEmailAttachment"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "storagePath";

ALTER TABLE "Album"
  DROP COLUMN IF EXISTS "fullZipFileSize",
  DROP COLUMN IF EXISTS "socialZipFileSize";

ALTER TABLE "AlbumPhoto"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "socialFileSize",
  DROP COLUMN IF EXISTS "socialStoragePath",
  DROP COLUMN IF EXISTS "storagePath",
  DROP COLUMN IF EXISTS "thumbnailFileSize",
  DROP COLUMN IF EXISTS "thumbnailStoragePath";

ALTER TABLE "ProjectFile"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "storagePath";

ALTER TABLE "ShareUploadFile"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "previewFileSize",
  DROP COLUMN IF EXISTS "previewPath",
  DROP COLUMN IF EXISTS "storagePath",
  DROP COLUMN IF EXISTS "timelinePreviewSpritesPath",
  DROP COLUMN IF EXISTS "timelinePreviewVttPath";

ALTER TABLE "Video"
  DROP COLUMN IF EXISTS "originalFileName",
  DROP COLUMN IF EXISTS "originalFileSize",
  DROP COLUMN IF EXISTS "originalStoragePath",
  DROP COLUMN IF EXISTS "preview1080Path",
  DROP COLUMN IF EXISTS "preview480Path",
  DROP COLUMN IF EXISTS "preview720Path",
  DROP COLUMN IF EXISTS "thumbnailPath",
  DROP COLUMN IF EXISTS "timelinePreviewSpritesPath",
  DROP COLUMN IF EXISTS "timelinePreviewVttPath";

ALTER TABLE "VideoAsset"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "previewFileSize",
  DROP COLUMN IF EXISTS "previewPath",
  DROP COLUMN IF EXISTS "storagePath",
  DROP COLUMN IF EXISTS "timelinePreviewSpritesPath",
  DROP COLUMN IF EXISTS "timelinePreviewVttPath";

ALTER TABLE "Settings"
  DROP COLUMN IF EXISTS "companyFaviconPath",
  DROP COLUMN IF EXISTS "companyLogoPath",
  DROP COLUMN IF EXISTS "darkLogoPath";

ALTER TABLE "CommentFile"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "storagePath";

ALTER TABLE "AccountingAttachment"
  DROP COLUMN IF EXISTS "fileSize",
  DROP COLUMN IF EXISTS "storagePath";
