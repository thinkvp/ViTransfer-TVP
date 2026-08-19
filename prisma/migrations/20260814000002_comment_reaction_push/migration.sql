-- Per-event toggle for emoji reaction push/bell notifications.
ALTER TABLE "PushNotificationSettings"
  ADD COLUMN "notifyCommentReactions" BOOLEAN NOT NULL DEFAULT true;
