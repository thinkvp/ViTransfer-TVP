-- Add viewer IP address to VideoAnalytics

ALTER TABLE "VideoAnalytics" ADD COLUMN IF NOT EXISTS "ipAddress" TEXT;

CREATE INDEX IF NOT EXISTS "VideoAnalytics_ipAddress_idx" ON "VideoAnalytics"("ipAddress");
