-- AlterTable
ALTER TABLE "PushNotificationSettings" ADD COLUMN "notifyPasswordResetRequested" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PushNotificationSettings" ADD COLUMN "notifyPasswordResetSuccess" BOOLEAN NOT NULL DEFAULT true;
