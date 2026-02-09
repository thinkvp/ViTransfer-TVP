-- Add viewer tracking columns to VideoAnalytics

ALTER TABLE "VideoAnalytics" ADD COLUMN IF NOT EXISTS "ipAddress" TEXT;
ALTER TABLE "VideoAnalytics" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

CREATE INDEX IF NOT EXISTS "VideoAnalytics_ipAddress_idx" ON "VideoAnalytics"("ipAddress");
CREATE INDEX IF NOT EXISTS "VideoAnalytics_sessionId_idx" ON "VideoAnalytics"("sessionId");
