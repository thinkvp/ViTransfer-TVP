-- Create per-video-version guest-only share links (random token, 14-day expiry).

CREATE TABLE "GuestVideoShareLink" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GuestVideoShareLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuestVideoShareLink_token_key" ON "GuestVideoShareLink"("token");
CREATE UNIQUE INDEX "GuestVideoShareLink_projectId_videoId_key" ON "GuestVideoShareLink"("projectId", "videoId");

CREATE INDEX "GuestVideoShareLink_expiresAt_idx" ON "GuestVideoShareLink"("expiresAt");
CREATE INDEX "GuestVideoShareLink_projectId_idx" ON "GuestVideoShareLink"("projectId");
CREATE INDEX "GuestVideoShareLink_videoId_idx" ON "GuestVideoShareLink"("videoId");

ALTER TABLE "GuestVideoShareLink"
  ADD CONSTRAINT "GuestVideoShareLink_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GuestVideoShareLink"
  ADD CONSTRAINT "GuestVideoShareLink_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "Video"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
