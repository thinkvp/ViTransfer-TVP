-- Remove deprecated title field from PushNotificationSettings.
ALTER TABLE "PushNotificationSettings" DROP COLUMN IF EXISTS "title";
