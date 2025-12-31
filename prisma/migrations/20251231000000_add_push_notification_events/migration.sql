-- Add new push notification event toggles

ALTER TABLE "PushNotificationSettings"
ADD COLUMN     "notifySuccessfulAdminLogin" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyFailedSharePasswordAttempt" BOOLEAN NOT NULL DEFAULT true;
