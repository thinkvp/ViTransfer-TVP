-- Persist share-auth metadata on analytics events and switched-share arrivals.

ALTER TABLE "VideoAnalytics"
ADD COLUMN "accessMethod" TEXT,
ADD COLUMN "email" TEXT;

ALTER TABLE "SharePageAccess"
ADD COLUMN "originProjectTitle" TEXT;