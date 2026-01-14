-- Add Sales Invoice Paid push notification toggle

ALTER TABLE "PushNotificationSettings"
ADD COLUMN IF NOT EXISTS "notifySalesInvoicePaid" BOOLEAN NOT NULL DEFAULT true;
