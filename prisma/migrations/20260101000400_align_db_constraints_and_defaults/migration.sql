-- Align DB constraints/defaults with Prisma schema
--
-- This migration is intended to eliminate remaining Prisma drift diffs by normalizing
-- foreign keys, defaults, and a couple of timestamp precisions.

-- Drop foreign keys so we can recreate them with the expected ON DELETE/ON UPDATE behavior.
ALTER TABLE "CommentFile" DROP CONSTRAINT IF EXISTS "CommentFile_commentId_fkey";
ALTER TABLE "CommentFile" DROP CONSTRAINT IF EXISTS "CommentFile_projectId_fkey";

ALTER TABLE "EmailTracking" DROP CONSTRAINT IF EXISTS "EmailTracking_projectId_fkey";
ALTER TABLE "EmailTracking" DROP CONSTRAINT IF EXISTS "EmailTracking_videoId_fkey";

ALTER TABLE "ProjectEmailEvent" DROP CONSTRAINT IF EXISTS "ProjectEmailEvent_projectId_fkey";
ALTER TABLE "ProjectEmailEvent" DROP CONSTRAINT IF EXISTS "ProjectEmailEvent_videoId_fkey";

-- Normalize timestamp precision (Prisma uses TIMESTAMP(3) by default for DateTime on Postgres).
ALTER TABLE "EmailTracking"
  ALTER COLUMN "sentAt" SET DATA TYPE TIMESTAMP(3) USING "sentAt"::timestamp(3),
  ALTER COLUMN "openedAt" SET DATA TYPE TIMESTAMP(3) USING "openedAt"::timestamp(3);

ALTER TABLE "ProjectEmailEvent"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3) USING "createdAt"::timestamp(3);

-- Normalize column defaults.
ALTER TABLE "Project"
  ALTER COLUMN "clientNotificationSchedule" SET DEFAULT 'HOURLY';

ALTER TABLE "Settings"
  ALTER COLUMN "adminNotificationSchedule" SET DEFAULT 'HOURLY';

ALTER TABLE "SecuritySettings"
  ALTER COLUMN "ipRateLimit" SET DEFAULT 1000,
  ALTER COLUMN "sessionRateLimit" SET DEFAULT 600;

-- Prisma doesn't define a default for transports array.
ALTER TABLE "PasskeyCredential"
  ALTER COLUMN "transports" DROP DEFAULT;

-- Prisma doesn't define a default for Video.name.
ALTER TABLE "Video"
  ALTER COLUMN "name" DROP DEFAULT;

-- Ensure expected index exists.
CREATE INDEX IF NOT EXISTS "CommentFile_projectId_createdAt_idx" ON "CommentFile"("projectId", "createdAt");

-- Recreate foreign keys with the expected referential actions.
ALTER TABLE "ProjectEmailEvent"
  ADD CONSTRAINT "ProjectEmailEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectEmailEvent"
  ADD CONSTRAINT "ProjectEmailEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmailTracking"
  ADD CONSTRAINT "EmailTracking_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailTracking"
  ADD CONSTRAINT "EmailTracking_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommentFile"
  ADD CONSTRAINT "CommentFile_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommentFile"
  ADD CONSTRAINT "CommentFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
