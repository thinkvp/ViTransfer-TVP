-- Add viewer IP address to VideoAnalytics

ALTER TABLE "VideoAnalytics" ADD COLUMN "ipAddress" TEXT;

CREATE INDEX "VideoAnalytics_ipAddress_idx" ON "VideoAnalytics"("ipAddress");
