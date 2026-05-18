-- Normalize legacy dropbox:-prefixed storage paths before removing Dropbox-only columns.
UPDATE "Project"
SET "storagePath" = regexp_replace("storagePath", '^dropbox:(/+)?', '')
WHERE "storagePath" LIKE 'dropbox:%';

UPDATE "ClientFile"
SET "storagePath" = regexp_replace("storagePath", '^dropbox:(/+)?', '')
WHERE "storagePath" LIKE 'dropbox:%';

UPDATE "UserFile"
SET "storagePath" = regexp_replace("storagePath", '^dropbox:(/+)?', '')
WHERE "storagePath" LIKE 'dropbox:%';

UPDATE "ProjectFile"
SET "storagePath" = regexp_replace("storagePath", '^dropbox:(/+)?', '')
WHERE "storagePath" LIKE 'dropbox:%';

UPDATE "CommentFile"
SET "storagePath" = regexp_replace("storagePath", '^dropbox:(/+)?', '')
WHERE "storagePath" LIKE 'dropbox:%';

UPDATE "ProjectEmail"
SET "rawStoragePath" = regexp_replace("rawStoragePath", '^dropbox:(/+)?', '')
WHERE "rawStoragePath" LIKE 'dropbox:%';

UPDATE "ProjectEmailAttachment"
SET "storagePath" = regexp_replace("storagePath", '^dropbox:(/+)?', '')
WHERE "storagePath" LIKE 'dropbox:%';

UPDATE "AlbumPhoto"
SET
  "storagePath" = regexp_replace("storagePath", '^dropbox:(/+)?', ''),
  "socialStoragePath" = CASE
    WHEN "socialStoragePath" LIKE 'dropbox:%' THEN regexp_replace("socialStoragePath", '^dropbox:(/+)?', '')
    ELSE "socialStoragePath"
  END,
  "thumbnailStoragePath" = CASE
    WHEN "thumbnailStoragePath" LIKE 'dropbox:%' THEN regexp_replace("thumbnailStoragePath", '^dropbox:(/+)?', '')
    ELSE "thumbnailStoragePath"
  END
WHERE
  "storagePath" LIKE 'dropbox:%'
  OR "socialStoragePath" LIKE 'dropbox:%'
  OR "thumbnailStoragePath" LIKE 'dropbox:%';

UPDATE "Video"
SET
  "originalStoragePath" = regexp_replace("originalStoragePath", '^dropbox:(/+)?', ''),
  "preview1080Path" = CASE
    WHEN "preview1080Path" LIKE 'dropbox:%' THEN regexp_replace("preview1080Path", '^dropbox:(/+)?', '')
    ELSE "preview1080Path"
  END,
  "preview720Path" = CASE
    WHEN "preview720Path" LIKE 'dropbox:%' THEN regexp_replace("preview720Path", '^dropbox:(/+)?', '')
    ELSE "preview720Path"
  END,
  "preview480Path" = CASE
    WHEN "preview480Path" LIKE 'dropbox:%' THEN regexp_replace("preview480Path", '^dropbox:(/+)?', '')
    ELSE "preview480Path"
  END,
  "thumbnailPath" = CASE
    WHEN "thumbnailPath" LIKE 'dropbox:%' THEN regexp_replace("thumbnailPath", '^dropbox:(/+)?', '')
    ELSE "thumbnailPath"
  END,
  "timelinePreviewVttPath" = CASE
    WHEN "timelinePreviewVttPath" LIKE 'dropbox:%' THEN regexp_replace("timelinePreviewVttPath", '^dropbox:(/+)?', '')
    ELSE "timelinePreviewVttPath"
  END,
  "timelinePreviewSpritesPath" = CASE
    WHEN "timelinePreviewSpritesPath" LIKE 'dropbox:%' THEN regexp_replace("timelinePreviewSpritesPath", '^dropbox:(/+)?', '')
    ELSE "timelinePreviewSpritesPath"
  END
WHERE
  "originalStoragePath" LIKE 'dropbox:%'
  OR "preview1080Path" LIKE 'dropbox:%'
  OR "preview720Path" LIKE 'dropbox:%'
  OR "preview480Path" LIKE 'dropbox:%'
  OR "thumbnailPath" LIKE 'dropbox:%'
  OR "timelinePreviewVttPath" LIKE 'dropbox:%'
  OR "timelinePreviewSpritesPath" LIKE 'dropbox:%';

UPDATE "VideoAsset"
SET "storagePath" = regexp_replace("storagePath", '^dropbox:(/+)?', '')
WHERE "storagePath" LIKE 'dropbox:%';

ALTER TABLE "Album"
  DROP COLUMN "dropboxEnabled",
  DROP COLUMN "fullZipDropboxStatus",
  DROP COLUMN "fullZipDropboxProgress",
  DROP COLUMN "fullZipDropboxError",
  DROP COLUMN "fullZipDropboxPath",
  DROP COLUMN "socialZipDropboxStatus",
  DROP COLUMN "socialZipDropboxProgress",
  DROP COLUMN "socialZipDropboxError",
  DROP COLUMN "socialZipDropboxPath";

ALTER TABLE "Video"
  DROP COLUMN "dropboxEnabled",
  DROP COLUMN "dropboxPath",
  DROP COLUMN "dropboxUploadStatus",
  DROP COLUMN "dropboxUploadProgress",
  DROP COLUMN "dropboxUploadError";

ALTER TABLE "VideoAsset"
  DROP COLUMN "dropboxEnabled",
  DROP COLUMN "dropboxPath",
  DROP COLUMN "dropboxUploadStatus",
  DROP COLUMN "dropboxUploadProgress",
  DROP COLUMN "dropboxUploadError";
