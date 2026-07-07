-- Project Activity feed: creator/approver attribution + chronological indexes

-- Video: upload + approval attribution
ALTER TABLE "Video"
  ADD COLUMN "uploadedById" TEXT,
  ADD COLUMN "uploadedByName" TEXT,
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvedByRecipientId" TEXT,
  ADD COLUMN "approvedByName" TEXT,
  ADD COLUMN "unapprovedAt" TIMESTAMP(3),
  ADD COLUMN "unapprovedById" TEXT,
  ADD COLUMN "unapprovedByRecipientId" TEXT,
  ADD COLUMN "unapprovedByName" TEXT;

-- Album: creator attribution
ALTER TABLE "Album"
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "createdByName" TEXT;

-- Share uploads: recipient attribution (uploadedById/uploadedByName already exist)
ALTER TABLE "ShareUploadFile" ADD COLUMN "uploadedByRecipientId" TEXT;
ALTER TABLE "ShareUploadFolder" ADD COLUMN "createdByRecipientId" TEXT;

-- Chronological-per-project indexes for the activity feed
CREATE INDEX "Video_projectId_createdAt_idx" ON "Video"("projectId", "createdAt");
CREATE INDEX "ShareUploadFile_projectId_createdAt_idx" ON "ShareUploadFile"("projectId", "createdAt");
CREATE INDEX "ShareUploadFolder_projectId_createdAt_idx" ON "ShareUploadFolder"("projectId", "createdAt");
CREATE INDEX "Comment_projectId_createdAt_idx" ON "Comment"("projectId", "createdAt");
CREATE INDEX "AlbumPhoto_albumId_createdAt_idx" ON "AlbumPhoto"("albumId", "createdAt");
