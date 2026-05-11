-- AlterTable: add S3 local backup settings to Settings model
ALTER TABLE "Settings" ADD COLUMN "s3LocalBackupEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "s3LocalBackupCategories" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Settings" ADD COLUMN "s3LocalBackupLastRunAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "s3LocalBackupLastRunResult" TEXT;
ALTER TABLE "Settings" ADD COLUMN "s3LocalBackupRunning" BOOLEAN NOT NULL DEFAULT false;
