-- Emoji reactions on share-page comments now appear in the batched summary emails, so a
-- reaction with no accompanying comment still tells the other side someone responded.
ALTER TYPE "NotificationQueueType" ADD VALUE IF NOT EXISTS 'COMMENT_REACTION';
