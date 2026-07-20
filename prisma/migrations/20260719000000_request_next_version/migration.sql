-- Client "Request Next Version": share-page "Reviewed" video state + comment locking
ALTER TABLE "Video"
  ADD COLUMN "revisionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "revisionRequestedById" TEXT,
  ADD COLUMN "revisionRequestedByRecipientId" TEXT,
  ADD COLUMN "revisionRequestedByName" TEXT;

ALTER TABLE "Comment"
  ADD COLUMN "lockedAt" TIMESTAMP(3);
