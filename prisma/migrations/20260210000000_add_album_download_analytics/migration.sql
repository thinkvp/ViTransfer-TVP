-- Add album/photo download analytics

CREATE TABLE "AlbumAnalytics" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "albumId" TEXT NOT NULL,
  "photoId" TEXT,
  "eventType" TEXT NOT NULL,
  "variant" TEXT,
  "ipAddress" TEXT,
  "sessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AlbumAnalytics_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AlbumAnalytics"
  ADD CONSTRAINT "AlbumAnalytics_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlbumAnalytics"
  ADD CONSTRAINT "AlbumAnalytics_albumId_fkey"
  FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlbumAnalytics"
  ADD CONSTRAINT "AlbumAnalytics_photoId_fkey"
  FOREIGN KEY ("photoId") REFERENCES "AlbumPhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AlbumAnalytics_projectId_createdAt_idx" ON "AlbumAnalytics"("projectId", "createdAt");
CREATE INDEX "AlbumAnalytics_albumId_createdAt_idx" ON "AlbumAnalytics"("albumId", "createdAt");
CREATE INDEX "AlbumAnalytics_photoId_idx" ON "AlbumAnalytics"("photoId");
CREATE INDEX "AlbumAnalytics_eventType_idx" ON "AlbumAnalytics"("eventType");
CREATE INDEX "AlbumAnalytics_sessionId_idx" ON "AlbumAnalytics"("sessionId");
