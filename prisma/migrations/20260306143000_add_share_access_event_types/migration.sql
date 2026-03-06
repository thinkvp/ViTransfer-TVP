-- Add typed share access events so project switches can be logged on both
-- the destination and origin projects without inflating visit counts.

ALTER TABLE "SharePageAccess"
ADD COLUMN "eventType" TEXT NOT NULL DEFAULT 'ACCESS',
ADD COLUMN "targetProjectTitle" TEXT;