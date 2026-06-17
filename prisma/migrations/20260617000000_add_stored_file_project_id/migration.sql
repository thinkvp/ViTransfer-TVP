-- Denormalized owning project for StoredFile rows.
-- Lets project-scoped lifecycle ops (delete, storage totals) run as a single query
-- instead of enumerating every entity type. NULL for non-project files (user / client /
-- branding / accounting). New rows are auto-populated by registerStoredFile().

-- 1. Column (IF NOT EXISTS so a dev DB that already has it via `prisma db push` doesn't error)
ALTER TABLE "StoredFile" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- 2. Backfill existing rows from the owning entity, per project-scoped entity type.

-- VIDEO → Video.projectId
UPDATE "StoredFile" sf
SET "projectId" = v."projectId"
FROM "Video" v
WHERE sf."entityType" = 'VIDEO' AND sf."entityId" = v."id";

-- VIDEO_ASSET → VideoAsset → Video.projectId
UPDATE "StoredFile" sf
SET "projectId" = v."projectId"
FROM "VideoAsset" va
JOIN "Video" v ON v."id" = va."videoId"
WHERE sf."entityType" = 'VIDEO_ASSET' AND sf."entityId" = va."id";

-- ALBUM → Album.projectId
UPDATE "StoredFile" sf
SET "projectId" = a."projectId"
FROM "Album" a
WHERE sf."entityType" = 'ALBUM' AND sf."entityId" = a."id";

-- ALBUM_PHOTO → AlbumPhoto → Album.projectId
UPDATE "StoredFile" sf
SET "projectId" = a."projectId"
FROM "AlbumPhoto" ap
JOIN "Album" a ON a."id" = ap."albumId"
WHERE sf."entityType" = 'ALBUM_PHOTO' AND sf."entityId" = ap."id";

-- PROJECT_FILE → ProjectFile.projectId
UPDATE "StoredFile" sf
SET "projectId" = pf."projectId"
FROM "ProjectFile" pf
WHERE sf."entityType" = 'PROJECT_FILE' AND sf."entityId" = pf."id";

-- SHARE_UPLOAD_FILE → ShareUploadFile.projectId
UPDATE "StoredFile" sf
SET "projectId" = suf."projectId"
FROM "ShareUploadFile" suf
WHERE sf."entityType" = 'SHARE_UPLOAD_FILE' AND sf."entityId" = suf."id";

-- COMMENT_FILE → CommentFile.projectId (denormalized on the entity itself)
UPDATE "StoredFile" sf
SET "projectId" = cf."projectId"
FROM "CommentFile" cf
WHERE sf."entityType" = 'COMMENT_FILE' AND sf."entityId" = cf."id";

-- PROJECT_EMAIL → ProjectEmail.projectId
UPDATE "StoredFile" sf
SET "projectId" = pe."projectId"
FROM "ProjectEmail" pe
WHERE sf."entityType" = 'PROJECT_EMAIL' AND sf."entityId" = pe."id";

-- PROJECT_EMAIL_ATTACHMENT → ProjectEmailAttachment → ProjectEmail.projectId
UPDATE "StoredFile" sf
SET "projectId" = pe."projectId"
FROM "ProjectEmailAttachment" pea
JOIN "ProjectEmail" pe ON pe."id" = pea."projectEmailId"
WHERE sf."entityType" = 'PROJECT_EMAIL_ATTACHMENT' AND sf."entityId" = pea."id";

-- Non-project entity types (USER_FILE, USER_AVATAR, CLIENT_FILE, SETTINGS_BRANDING,
-- ACCOUNTING_ATTACHMENT) intentionally keep projectId = NULL.

-- 3. Index for project-scoped lookups
CREATE INDEX IF NOT EXISTS "StoredFile_projectId_idx" ON "StoredFile"("projectId");
