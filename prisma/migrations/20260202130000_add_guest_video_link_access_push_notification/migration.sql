-- Add push notification toggle for guest video link access
ALTER TABLE "PushNotificationSettings"
ADD COLUMN IF NOT EXISTS "notifyGuestVideoLinkAccess" BOOLEAN NOT NULL DEFAULT true;
