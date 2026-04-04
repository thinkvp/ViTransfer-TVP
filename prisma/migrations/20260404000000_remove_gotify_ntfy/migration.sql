-- Remove Gotify/Ntfy webhook fields from PushNotificationSettings.
-- Push notifications now use browser push and in-app bell only.
ALTER TABLE "PushNotificationSettings" DROP COLUMN IF EXISTS "provider";
ALTER TABLE "PushNotificationSettings" DROP COLUMN IF EXISTS "webhookUrl";
