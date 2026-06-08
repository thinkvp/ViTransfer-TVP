-- Create enums
CREATE TYPE "EntityType" AS ENUM (
  'VIDEO',
  'VIDEO_ASSET',
  'SHARE_UPLOAD_FILE',
  'ALBUM_PHOTO',
  'ALBUM',
  'PROJECT_FILE',
  'CLIENT_FILE',
  'USER_FILE',
  'USER_AVATAR',
  'PROJECT_EMAIL',
  'PROJECT_EMAIL_ATTACHMENT',
  'COMMENT_FILE',
  'ACCOUNTING_ATTACHMENT',
  'SETTINGS_BRANDING'
);

CREATE TYPE "FileRole" AS ENUM (
  'ORIGINAL',
  'PREVIEW_480',
  'PREVIEW_720',
  'PREVIEW_1080',
  'THUMBNAIL',
  'PREVIEW_IMAGE',
  'PREVIEW_MP4',
  'SOCIAL',
  'TIMELINE_VTT',
  'TIMELINE_SPRITES',
  'AVATAR',
  'COMPANY_LOGO',
  'COMPANY_DARK_LOGO',
  'COMPANY_FAVICON',
  'RAW_EMAIL',
  'ZIP_FULL',
  'ZIP_SOCIAL'
);

-- Create StoredFile table
CREATE TABLE "StoredFile" (
  "id"          TEXT         NOT NULL,
  "entityType"  "EntityType" NOT NULL,
  "entityId"    TEXT         NOT NULL,
  "fileRole"    "FileRole"   NOT NULL,
  "storagePath" TEXT         NOT NULL,
  "fileName"    TEXT,
  "fileSize"    BIGINT,
  "status"      TEXT,
  "generatedAt" TIMESTAMP(3),
  "metadata"    JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- Each entity can only have one file per role
CREATE UNIQUE INDEX "StoredFile_entityType_entityId_fileRole_key"
  ON "StoredFile"("entityType", "entityId", "fileRole");

-- Fast lookup by entity
CREATE INDEX "StoredFile_entityType_entityId_idx"
  ON "StoredFile"("entityType", "entityId");

-- Fast lookup by storage path (for scans, renames)
CREATE INDEX "StoredFile_storagePath_idx"
  ON "StoredFile"("storagePath");

-- Temporarily set a default for id so the backfill INSERTs don't need to
-- generate IDs themselves. Dropped at the end of this migration — Prisma
-- Client handles id generation via @default(cuid()).
ALTER TABLE "StoredFile" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;

-- Backfill from existing path columns (dual-write phase)

-- Video: 7 file roles per video
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO'::"EntityType",
  v."id",
  'ORIGINAL'::"FileRole",
  v."originalStoragePath",
  v."originalFileName",
  v."originalFileSize",
  CASE v."status"
    WHEN 'READY' THEN 'READY'
    WHEN 'ERROR' THEN 'ERROR'
    ELSE 'PENDING'
  END
FROM "Video" v
WHERE v."originalStoragePath" IS NOT NULL AND v."originalStoragePath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO'::"EntityType", v."id", 'PREVIEW_480'::"FileRole",
  v."preview480Path", NULL, NULL, 'READY'
FROM "Video" v WHERE v."preview480Path" IS NOT NULL AND v."preview480Path" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO'::"EntityType", v."id", 'PREVIEW_720'::"FileRole",
  v."preview720Path", NULL, NULL, 'READY'
FROM "Video" v WHERE v."preview720Path" IS NOT NULL AND v."preview720Path" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO'::"EntityType", v."id", 'PREVIEW_1080'::"FileRole",
  v."preview1080Path", NULL, NULL, 'READY'
FROM "Video" v WHERE v."preview1080Path" IS NOT NULL AND v."preview1080Path" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO'::"EntityType", v."id", 'THUMBNAIL'::"FileRole",
  v."thumbnailPath", NULL, NULL, 'READY'
FROM "Video" v WHERE v."thumbnailPath" IS NOT NULL AND v."thumbnailPath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO'::"EntityType", v."id", 'TIMELINE_VTT'::"FileRole",
  v."timelinePreviewVttPath", NULL, NULL,
  CASE WHEN v."timelinePreviewsReady" THEN 'READY' ELSE NULL END
FROM "Video" v WHERE v."timelinePreviewVttPath" IS NOT NULL AND v."timelinePreviewVttPath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO'::"EntityType", v."id", 'TIMELINE_SPRITES'::"FileRole",
  v."timelinePreviewSpritesPath", NULL, NULL,
  CASE WHEN v."timelinePreviewsReady" THEN 'READY' ELSE NULL END
FROM "Video" v WHERE v."timelinePreviewSpritesPath" IS NOT NULL AND v."timelinePreviewSpritesPath" != ''
ON CONFLICT DO NOTHING;

-- VideoAsset: 4 file roles per asset
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO_ASSET'::"EntityType", a."id", 'ORIGINAL'::"FileRole",
  a."storagePath", a."fileName", a."fileSize",
  'READY'
FROM "VideoAsset" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO_ASSET'::"EntityType", a."id", 'PREVIEW_IMAGE'::"FileRole",
  a."previewPath", NULL, a."previewFileSize", a."previewStatus"
FROM "VideoAsset" a WHERE a."previewPath" IS NOT NULL AND a."previewPath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO_ASSET'::"EntityType", a."id", 'TIMELINE_VTT'::"FileRole",
  a."timelinePreviewVttPath", NULL, NULL,
  CASE WHEN a."timelinePreviewsReady" THEN 'READY' ELSE NULL END
FROM "VideoAsset" a WHERE a."timelinePreviewVttPath" IS NOT NULL AND a."timelinePreviewVttPath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'VIDEO_ASSET'::"EntityType", a."id", 'TIMELINE_SPRITES'::"FileRole",
  a."timelinePreviewSpritesPath", NULL, NULL,
  CASE WHEN a."timelinePreviewsReady" THEN 'READY' ELSE NULL END
FROM "VideoAsset" a WHERE a."timelinePreviewSpritesPath" IS NOT NULL AND a."timelinePreviewSpritesPath" != ''
ON CONFLICT DO NOTHING;

-- ShareUploadFile: 4 file roles per upload
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
  f."storagePath", f."fileName", f."fileSize", 'READY'
FROM "ShareUploadFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'PREVIEW_IMAGE'::"FileRole",
  f."previewPath", NULL, f."previewFileSize", f."previewStatus"
FROM "ShareUploadFile" f WHERE f."previewPath" IS NOT NULL AND f."previewPath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'TIMELINE_VTT'::"FileRole",
  f."timelinePreviewVttPath", NULL, NULL,
  CASE WHEN f."timelinePreviewsReady" THEN 'READY' ELSE NULL END
FROM "ShareUploadFile" f WHERE f."timelinePreviewVttPath" IS NOT NULL AND f."timelinePreviewVttPath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'TIMELINE_SPRITES'::"FileRole",
  f."timelinePreviewSpritesPath", NULL, NULL,
  CASE WHEN f."timelinePreviewsReady" THEN 'READY' ELSE NULL END
FROM "ShareUploadFile" f WHERE f."timelinePreviewSpritesPath" IS NOT NULL AND f."timelinePreviewSpritesPath" != ''
ON CONFLICT DO NOTHING;

-- AlbumPhoto: 3 file roles per photo
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'ALBUM_PHOTO'::"EntityType", p."id", 'ORIGINAL'::"FileRole",
  p."storagePath", p."fileName", p."fileSize",
  CASE p."status" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' ELSE 'PENDING' END
FROM "AlbumPhoto" p WHERE p."storagePath" IS NOT NULL AND p."storagePath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'ALBUM_PHOTO'::"EntityType", p."id", 'SOCIAL'::"FileRole",
  p."socialStoragePath", NULL, p."socialFileSize",
  CASE p."socialStatus" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' WHEN 'PROCESSING' THEN 'PROCESSING' ELSE 'PENDING' END
FROM "AlbumPhoto" p WHERE p."socialStoragePath" IS NOT NULL AND p."socialStoragePath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'ALBUM_PHOTO'::"EntityType", p."id", 'THUMBNAIL'::"FileRole",
  p."thumbnailStoragePath", NULL, p."thumbnailFileSize",
  CASE p."thumbnailStatus" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' WHEN 'PROCESSING' THEN 'PROCESSING' ELSE 'PENDING' END
FROM "AlbumPhoto" p WHERE p."thumbnailStoragePath" IS NOT NULL AND p."thumbnailStoragePath" != ''
ON CONFLICT DO NOTHING;

-- Album ZIP files (derived from name+project path, not stored as a column)
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'ALBUM'::"EntityType", a."id", 'ZIP_FULL'::"FileRole",
  -- Path derived from buildAlbumZipStoragePath: {project}/albums/{folder}/zips/full/{name}_Full_Res.zip
  COALESCE(p."storagePath", '') || '/albums/' || COALESCE(a."storageFolderName", a."name") || '/zips/full/' || a."name" || '_Full_Res.zip',
  a."name" || '_Full_Res.zip',
  a."fullZipFileSize",
  'READY'
FROM "Album" a
JOIN "Project" p ON p."id" = a."projectId"
WHERE a."fullZipFileSize" > 0 AND p."storagePath" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'ALBUM'::"EntityType", a."id", 'ZIP_SOCIAL'::"FileRole",
  COALESCE(p."storagePath", '') || '/albums/' || COALESCE(a."storageFolderName", a."name") || '/zips/social/' || a."name" || '_Social_Sized.zip',
  a."name" || '_Social_Sized.zip',
  a."socialZipFileSize",
  'READY'
FROM "Album" a
JOIN "Project" p ON p."id" = a."projectId"
WHERE a."socialZipFileSize" > 0 AND p."storagePath" IS NOT NULL
ON CONFLICT DO NOTHING;

-- User avatar
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "status")
SELECT
  'USER_AVATAR'::"EntityType", u."id", 'AVATAR'::"FileRole",
  u."avatarPath", NULL, 'READY'
FROM "User" u WHERE u."avatarPath" IS NOT NULL AND u."avatarPath" != ''
ON CONFLICT DO NOTHING;

-- Settings branding (3 roles, all share entityId 'default')
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "status")
SELECT
  'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_LOGO'::"FileRole",
  s."companyLogoPath", 'READY'
FROM "Settings" s WHERE s."companyLogoPath" IS NOT NULL AND s."companyLogoPath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "status")
SELECT
  'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_DARK_LOGO'::"FileRole",
  s."darkLogoPath", 'READY'
FROM "Settings" s WHERE s."darkLogoPath" IS NOT NULL AND s."darkLogoPath" != ''
ON CONFLICT DO NOTHING;

INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "status")
SELECT
  'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_FAVICON'::"FileRole",
  s."companyFaviconPath", 'READY'
FROM "Settings" s WHERE s."companyFaviconPath" IS NOT NULL AND s."companyFaviconPath" != ''
ON CONFLICT DO NOTHING;

-- ProjectFile
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'PROJECT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
  f."storagePath", f."fileName", f."fileSize", 'READY'
FROM "ProjectFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
ON CONFLICT DO NOTHING;

-- ClientFile
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'CLIENT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
  f."storagePath", f."fileName", f."fileSize", 'READY'
FROM "ClientFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
ON CONFLICT DO NOTHING;

-- UserFile
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'USER_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
  f."storagePath", f."fileName", f."fileSize", 'READY'
FROM "UserFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
ON CONFLICT DO NOTHING;

-- ProjectEmail
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'PROJECT_EMAIL'::"EntityType", e."id", 'RAW_EMAIL'::"FileRole",
  e."rawStoragePath", e."rawFileName", e."rawFileSize", 'READY'
FROM "ProjectEmail" e WHERE e."rawStoragePath" IS NOT NULL AND e."rawStoragePath" != ''
ON CONFLICT DO NOTHING;

-- ProjectEmailAttachment
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'PROJECT_EMAIL_ATTACHMENT'::"EntityType", a."id", 'ORIGINAL'::"FileRole",
  a."storagePath", a."fileName", a."fileSize", 'READY'
FROM "ProjectEmailAttachment" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != ''
ON CONFLICT DO NOTHING;

-- CommentFile
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'COMMENT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole",
  f."storagePath", f."fileName", f."fileSize", 'READY'
FROM "CommentFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != ''
ON CONFLICT DO NOTHING;

-- AccountingAttachment
INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
SELECT
  'ACCOUNTING_ATTACHMENT'::"EntityType", a."id", 'ORIGINAL'::"FileRole",
  a."storagePath", a."originalName", a."fileSize", 'READY'
FROM "AccountingAttachment" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != ''
ON CONFLICT DO NOTHING;

-- Remove the temporary id default; Prisma Client handles id generation via @default(cuid())
ALTER TABLE "StoredFile" ALTER COLUMN "id" DROP DEFAULT;
