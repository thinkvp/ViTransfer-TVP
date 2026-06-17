-- Re-backfill the StoredFile registry from the legacy path columns.
--
-- WHY THIS EXISTS
-- The original registry migration (20260608000002_add_stored_file_registry) created
-- StoredFile and backfilled it ONCE. The app version shipped alongside it (v1.9.7) did
-- NOT yet write to StoredFile — it kept writing only to the legacy *Path / *FileSize
-- columns. So between that deploy and this upgrade, every newly uploaded/processed file
-- exists ONLY in the legacy columns and is MISSING from StoredFile ("gap" rows).
--
-- This migration re-runs the exact backfill so those gaps are captured BEFORE the
-- companion migration (20260618000001_drop_legacy_file_columns) removes the legacy
-- columns. Without this, dropping the columns would permanently lose all references to
-- files created during that window.
--
-- IDEMPOTENT + DEFENSIVE
--   * ON CONFLICT DO NOTHING — only inserts missing rows; never overwrites an existing
--     row (so the timeline-path fix from 20260609000001 is preserved for prior rows).
--   * Each table's backfill is gated on the legacy columns still existing. On a database
--     where the columns were already removed (e.g. a dev DB synced via `prisma db push`),
--     the gated blocks are skipped and this migration is a clean no-op.
--
-- The INSERTs below mirror 20260608000002 verbatim; the dynamic-EXECUTE wrappers only add
-- the existence guard. Keep the two in sync if the legacy mapping ever changes.

-- StoredFile.id has no DB-level default (Prisma generates cuids client-side; the original
-- registry migration set a temporary default only for the duration of its backfill, then
-- dropped it). Re-create that temporary default so these INSERTs can omit id, then drop it
-- again at the end — exactly as 20260608000002 did.
ALTER TABLE "StoredFile" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;

-- Video: 7 file roles per video
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'Video' AND column_name = 'originalStoragePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO'::"EntityType", v."id", 'ORIGINAL'::"FileRole",
        v."originalStoragePath", v."originalFileName", v."originalFileSize",
        CASE v."status" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' ELSE 'PENDING' END
      FROM "Video" v WHERE v."originalStoragePath" IS NOT NULL AND v."originalStoragePath" != ''
      ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO'::"EntityType", v."id", 'PREVIEW_480'::"FileRole", v."preview480Path", NULL, NULL, 'READY'
      FROM "Video" v WHERE v."preview480Path" IS NOT NULL AND v."preview480Path" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO'::"EntityType", v."id", 'PREVIEW_720'::"FileRole", v."preview720Path", NULL, NULL, 'READY'
      FROM "Video" v WHERE v."preview720Path" IS NOT NULL AND v."preview720Path" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO'::"EntityType", v."id", 'PREVIEW_1080'::"FileRole", v."preview1080Path", NULL, NULL, 'READY'
      FROM "Video" v WHERE v."preview1080Path" IS NOT NULL AND v."preview1080Path" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO'::"EntityType", v."id", 'THUMBNAIL'::"FileRole", v."thumbnailPath", NULL, NULL, 'READY'
      FROM "Video" v WHERE v."thumbnailPath" IS NOT NULL AND v."thumbnailPath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO'::"EntityType", v."id", 'TIMELINE_VTT'::"FileRole", v."timelinePreviewVttPath", NULL, NULL,
        CASE WHEN v."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "Video" v WHERE v."timelinePreviewVttPath" IS NOT NULL AND v."timelinePreviewVttPath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO'::"EntityType", v."id", 'TIMELINE_SPRITES'::"FileRole", v."timelinePreviewSpritesPath", NULL, NULL,
        CASE WHEN v."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "Video" v WHERE v."timelinePreviewSpritesPath" IS NOT NULL AND v."timelinePreviewSpritesPath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- VideoAsset: 4 file roles per asset
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'VideoAsset' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO_ASSET'::"EntityType", a."id", 'ORIGINAL'::"FileRole", a."storagePath", a."fileName", a."fileSize", 'READY'
      FROM "VideoAsset" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO_ASSET'::"EntityType", a."id", 'PREVIEW_IMAGE'::"FileRole", a."previewPath", NULL, a."previewFileSize", a."previewStatus"
      FROM "VideoAsset" a WHERE a."previewPath" IS NOT NULL AND a."previewPath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO_ASSET'::"EntityType", a."id", 'TIMELINE_VTT'::"FileRole", a."timelinePreviewVttPath", NULL, NULL,
        CASE WHEN a."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "VideoAsset" a WHERE a."timelinePreviewVttPath" IS NOT NULL AND a."timelinePreviewVttPath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'VIDEO_ASSET'::"EntityType", a."id", 'TIMELINE_SPRITES'::"FileRole", a."timelinePreviewSpritesPath", NULL, NULL,
        CASE WHEN a."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "VideoAsset" a WHERE a."timelinePreviewSpritesPath" IS NOT NULL AND a."timelinePreviewSpritesPath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- ShareUploadFile: 4 file roles per upload
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ShareUploadFile' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole", f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "ShareUploadFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'PREVIEW_IMAGE'::"FileRole", f."previewPath", NULL, f."previewFileSize", f."previewStatus"
      FROM "ShareUploadFile" f WHERE f."previewPath" IS NOT NULL AND f."previewPath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'TIMELINE_VTT'::"FileRole", f."timelinePreviewVttPath", NULL, NULL,
        CASE WHEN f."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "ShareUploadFile" f WHERE f."timelinePreviewVttPath" IS NOT NULL AND f."timelinePreviewVttPath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'SHARE_UPLOAD_FILE'::"EntityType", f."id", 'TIMELINE_SPRITES'::"FileRole", f."timelinePreviewSpritesPath", NULL, NULL,
        CASE WHEN f."timelinePreviewsReady" THEN 'READY' ELSE NULL END
      FROM "ShareUploadFile" f WHERE f."timelinePreviewSpritesPath" IS NOT NULL AND f."timelinePreviewSpritesPath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- AlbumPhoto: 3 file roles per photo
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'AlbumPhoto' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'ALBUM_PHOTO'::"EntityType", p."id", 'ORIGINAL'::"FileRole", p."storagePath", p."fileName", p."fileSize",
        CASE p."status" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' ELSE 'PENDING' END
      FROM "AlbumPhoto" p WHERE p."storagePath" IS NOT NULL AND p."storagePath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'ALBUM_PHOTO'::"EntityType", p."id", 'SOCIAL'::"FileRole", p."socialStoragePath", NULL, p."socialFileSize",
        CASE p."socialStatus" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' WHEN 'PROCESSING' THEN 'PROCESSING' ELSE 'PENDING' END
      FROM "AlbumPhoto" p WHERE p."socialStoragePath" IS NOT NULL AND p."socialStoragePath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'ALBUM_PHOTO'::"EntityType", p."id", 'THUMBNAIL'::"FileRole", p."thumbnailStoragePath", NULL, p."thumbnailFileSize",
        CASE p."thumbnailStatus" WHEN 'READY' THEN 'READY' WHEN 'ERROR' THEN 'ERROR' WHEN 'PROCESSING' THEN 'PROCESSING' ELSE 'PENDING' END
      FROM "AlbumPhoto" p WHERE p."thumbnailStoragePath" IS NOT NULL AND p."thumbnailStoragePath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- Album ZIP files (path derived from project + album folder, not a stored column)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'Album' AND column_name = 'fullZipFileSize') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'ALBUM'::"EntityType", a."id", 'ZIP_FULL'::"FileRole",
        COALESCE(p."storagePath", '') || '/albums/' || COALESCE(a."storageFolderName", a."name") || '/zips/full/' || a."name" || '_Full_Res.zip',
        a."name" || '_Full_Res.zip', a."fullZipFileSize", 'READY'
      FROM "Album" a JOIN "Project" p ON p."id" = a."projectId"
      WHERE a."fullZipFileSize" > 0 AND p."storagePath" IS NOT NULL ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'ALBUM'::"EntityType", a."id", 'ZIP_SOCIAL'::"FileRole",
        COALESCE(p."storagePath", '') || '/albums/' || COALESCE(a."storageFolderName", a."name") || '/zips/social/' || a."name" || '_Social_Sized.zip',
        a."name" || '_Social_Sized.zip', a."socialZipFileSize", 'READY'
      FROM "Album" a JOIN "Project" p ON p."id" = a."projectId"
      WHERE a."socialZipFileSize" > 0 AND p."storagePath" IS NOT NULL ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- User avatar
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'User' AND column_name = 'avatarPath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "status")
      SELECT 'USER_AVATAR'::"EntityType", u."id", 'AVATAR'::"FileRole", u."avatarPath", NULL, 'READY'
      FROM "User" u WHERE u."avatarPath" IS NOT NULL AND u."avatarPath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- Settings branding (3 roles, all share the Settings row id)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'Settings' AND column_name = 'companyLogoPath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "status")
      SELECT 'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_LOGO'::"FileRole", s."companyLogoPath", 'READY'
      FROM "Settings" s WHERE s."companyLogoPath" IS NOT NULL AND s."companyLogoPath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "status")
      SELECT 'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_DARK_LOGO'::"FileRole", s."darkLogoPath", 'READY'
      FROM "Settings" s WHERE s."darkLogoPath" IS NOT NULL AND s."darkLogoPath" != '' ON CONFLICT DO NOTHING;

      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "status")
      SELECT 'SETTINGS_BRANDING'::"EntityType", s."id", 'COMPANY_FAVICON'::"FileRole", s."companyFaviconPath", 'READY'
      FROM "Settings" s WHERE s."companyFaviconPath" IS NOT NULL AND s."companyFaviconPath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- ProjectFile
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ProjectFile' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'PROJECT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole", f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "ProjectFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- ClientFile
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ClientFile' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'CLIENT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole", f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "ClientFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- UserFile
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'UserFile' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'USER_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole", f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "UserFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- ProjectEmail
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ProjectEmail' AND column_name = 'rawStoragePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'PROJECT_EMAIL'::"EntityType", e."id", 'RAW_EMAIL'::"FileRole", e."rawStoragePath", e."rawFileName", e."rawFileSize", 'READY'
      FROM "ProjectEmail" e WHERE e."rawStoragePath" IS NOT NULL AND e."rawStoragePath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- ProjectEmailAttachment
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ProjectEmailAttachment' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'PROJECT_EMAIL_ATTACHMENT'::"EntityType", a."id", 'ORIGINAL'::"FileRole", a."storagePath", a."fileName", a."fileSize", 'READY'
      FROM "ProjectEmailAttachment" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- CommentFile
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'CommentFile' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'COMMENT_FILE'::"EntityType", f."id", 'ORIGINAL'::"FileRole", f."storagePath", f."fileName", f."fileSize", 'READY'
      FROM "CommentFile" f WHERE f."storagePath" IS NOT NULL AND f."storagePath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- AccountingAttachment (separate storage root; keeps originalName)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'AccountingAttachment' AND column_name = 'storagePath') THEN
    EXECUTE $sql$
      INSERT INTO "StoredFile" ("entityType", "entityId", "fileRole", "storagePath", "fileName", "fileSize", "status")
      SELECT 'ACCOUNTING_ATTACHMENT'::"EntityType", a."id", 'ORIGINAL'::"FileRole", a."storagePath", a."originalName", a."fileSize", 'READY'
      FROM "AccountingAttachment" a WHERE a."storagePath" IS NOT NULL AND a."storagePath" != '' ON CONFLICT DO NOTHING;
    $sql$;
  END IF;
END $$;

-- Re-apply the timeline-path fix (idempotent) so any gap rows just inserted above get the
-- corrected /timeline-previews/ paths, matching 20260609000001.
UPDATE "StoredFile"
SET "storagePath" = "storagePath" || '/timeline-previews'
WHERE "fileRole" = 'TIMELINE_SPRITES'
  AND "storagePath" NOT LIKE '%/timeline-previews';

UPDATE "StoredFile"
SET "storagePath" = REPLACE("storagePath", '/index.vtt', '/timeline-previews/index.vtt')
WHERE "fileRole" = 'TIMELINE_VTT'
  AND "storagePath" LIKE '%/index.vtt'
  AND "storagePath" NOT LIKE '%/timeline-previews/index.vtt';

-- Re-run the projectId backfill (idempotent) so gap rows get their denormalized projectId,
-- matching 20260617000000. The projectId column is guaranteed to exist here (that migration
-- runs earlier). Only rows still NULL are touched.
UPDATE "StoredFile" sf SET "projectId" = v."projectId"
FROM "Video" v WHERE sf."entityType" = 'VIDEO' AND sf."entityId" = v."id" AND sf."projectId" IS NULL;

UPDATE "StoredFile" sf SET "projectId" = v."projectId"
FROM "VideoAsset" va JOIN "Video" v ON v."id" = va."videoId"
WHERE sf."entityType" = 'VIDEO_ASSET' AND sf."entityId" = va."id" AND sf."projectId" IS NULL;

UPDATE "StoredFile" sf SET "projectId" = a."projectId"
FROM "Album" a WHERE sf."entityType" = 'ALBUM' AND sf."entityId" = a."id" AND sf."projectId" IS NULL;

UPDATE "StoredFile" sf SET "projectId" = a."projectId"
FROM "AlbumPhoto" ap JOIN "Album" a ON a."id" = ap."albumId"
WHERE sf."entityType" = 'ALBUM_PHOTO' AND sf."entityId" = ap."id" AND sf."projectId" IS NULL;

UPDATE "StoredFile" sf SET "projectId" = pf."projectId"
FROM "ProjectFile" pf WHERE sf."entityType" = 'PROJECT_FILE' AND sf."entityId" = pf."id" AND sf."projectId" IS NULL;

UPDATE "StoredFile" sf SET "projectId" = suf."projectId"
FROM "ShareUploadFile" suf WHERE sf."entityType" = 'SHARE_UPLOAD_FILE' AND sf."entityId" = suf."id" AND sf."projectId" IS NULL;

UPDATE "StoredFile" sf SET "projectId" = cf."projectId"
FROM "CommentFile" cf WHERE sf."entityType" = 'COMMENT_FILE' AND sf."entityId" = cf."id" AND sf."projectId" IS NULL;

UPDATE "StoredFile" sf SET "projectId" = pe."projectId"
FROM "ProjectEmail" pe WHERE sf."entityType" = 'PROJECT_EMAIL' AND sf."entityId" = pe."id" AND sf."projectId" IS NULL;

UPDATE "StoredFile" sf SET "projectId" = pe."projectId"
FROM "ProjectEmailAttachment" pea JOIN "ProjectEmail" pe ON pe."id" = pea."projectEmailId"
WHERE sf."entityType" = 'PROJECT_EMAIL_ATTACHMENT' AND sf."entityId" = pea."id" AND sf."projectId" IS NULL;

-- Remove the temporary id default again; Prisma Client owns id generation via @default(cuid()).
ALTER TABLE "StoredFile" ALTER COLUMN "id" DROP DEFAULT;
