-- Add toggle for "Sales Quote Accepted" push notification
ALTER TABLE "PushNotificationSettings"
ADD COLUMN "notifySalesQuoteAccepted" BOOLEAN NOT NULL DEFAULT true;
