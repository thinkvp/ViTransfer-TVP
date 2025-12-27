-- Create table to track email opens via tracking pixels
CREATE TABLE "EmailTracking" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "type" TEXT NOT NULL, -- ALL_READY_VIDEOS or SPECIFIC_VIDEO_VERSION
  "videoId" TEXT,
  "recipientEmail" TEXT NOT NULL,
  "sentAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedAt" TIMESTAMP,
  CONSTRAINT "EmailTracking_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailTracking_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE,
  CONSTRAINT "EmailTracking_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL
);

-- Unique constraint on token
CREATE UNIQUE INDEX "EmailTracking_token_key" ON "EmailTracking"("token");

-- Indexes for efficient querying
CREATE INDEX "EmailTracking_projectId_openedAt_idx" ON "EmailTracking" ("projectId", "openedAt");
CREATE INDEX "EmailTracking_token_idx" ON "EmailTracking" ("token");
CREATE INDEX "EmailTracking_recipientEmail_idx" ON "EmailTracking" ("recipientEmail");
