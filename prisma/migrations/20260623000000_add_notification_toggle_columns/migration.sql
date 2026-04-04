-- AlterTable - add new notification toggle columns
ALTER TABLE "PushNotificationSettings" ADD COLUMN "notifyInternalComments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PushNotificationSettings" ADD COLUMN "notifyTaskComments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PushNotificationSettings" ADD COLUMN "notifyUserAssignments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PushNotificationSettings" ADD COLUMN "notifySalesReminders" BOOLEAN NOT NULL DEFAULT true;
