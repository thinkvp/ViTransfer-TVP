-- Create table to track project email notifications sent to clients
CREATE TABLE "ProjectEmailEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "type" TEXT NOT NULL, -- ALL_READY_VIDEOS or SPECIFIC_VIDEO_VERSION
  "videoId" TEXT,
  "recipientEmails" TEXT NOT NULL, -- JSON array of email addresses
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectEmailEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectEmailEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE,
  CONSTRAINT "ProjectEmailEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL
);

-- Indexes for efficient querying
CREATE INDEX "ProjectEmailEvent_projectId_createdAt_idx" ON "ProjectEmailEvent" ("projectId", "createdAt");
CREATE INDEX "ProjectEmailEvent_videoId_idx" ON "ProjectEmailEvent" ("videoId");
CREATE INDEX "ProjectEmailEvent_type_idx" ON "ProjectEmailEvent" ("type");
