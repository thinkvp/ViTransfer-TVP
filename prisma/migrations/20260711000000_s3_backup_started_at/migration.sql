-- AlterTable: track when the current S3-local-backup run acquired the lock, so a
-- stale flag left by a hung/killed run can self-heal instead of blocking forever.
ALTER TABLE "Settings" ADD COLUMN "s3LocalBackupStartedAt" TIMESTAMP(3);
