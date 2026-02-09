-- Add session ID to VideoAnalytics for mapping to share access

ALTER TABLE "VideoAnalytics" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

CREATE INDEX IF NOT EXISTS "VideoAnalytics_sessionId_idx" ON "VideoAnalytics"("sessionId");
