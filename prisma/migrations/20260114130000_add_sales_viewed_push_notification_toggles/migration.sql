-- Add toggles for "Sales Quote Viewed" and "Sales Invoice Viewed" push notifications

ALTER TABLE "PushNotificationSettings"
ADD COLUMN "notifySalesQuoteViewed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notifySalesInvoiceViewed" BOOLEAN NOT NULL DEFAULT true;
