-- Per-album guest-only share links (/ga/<token>), mirroring GuestVideoShareLink.
CREATE TABLE "GuestAlbumShareLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestAlbumShareLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuestAlbumShareLink_token_key" ON "GuestAlbumShareLink"("token");
CREATE INDEX "GuestAlbumShareLink_expiresAt_idx" ON "GuestAlbumShareLink"("expiresAt");
CREATE INDEX "GuestAlbumShareLink_projectId_idx" ON "GuestAlbumShareLink"("projectId");
CREATE INDEX "GuestAlbumShareLink_albumId_idx" ON "GuestAlbumShareLink"("albumId");
CREATE UNIQUE INDEX "GuestAlbumShareLink_projectId_albumId_key" ON "GuestAlbumShareLink"("projectId", "albumId");

ALTER TABLE "GuestAlbumShareLink" ADD CONSTRAINT "GuestAlbumShareLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestAlbumShareLink" ADD CONSTRAINT "GuestAlbumShareLink_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;
