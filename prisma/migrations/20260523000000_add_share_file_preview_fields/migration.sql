-- Add preview lifecycle fields to ShareUploadFile
ALTER TABLE "ShareUploadFile"
  ADD COLUMN "previewStatus"      TEXT,
  ADD COLUMN "previewPath"        TEXT,
  ADD COLUMN "previewError"       TEXT,
  ADD COLUMN "previewGeneratedAt" TIMESTAMP(3),
  ADD COLUMN "previewFileSize"    BIGINT,
  ADD COLUMN "previewAttempts"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "previewQueuedAt"    TIMESTAMP(3);

CREATE INDEX "ShareUploadFile_previewStatus_idx" ON "ShareUploadFile"("previewStatus");

-- Add preview lifecycle fields to VideoAsset
ALTER TABLE "VideoAsset"
  ADD COLUMN "previewStatus"      TEXT,
  ADD COLUMN "previewPath"        TEXT,
  ADD COLUMN "previewError"       TEXT,
  ADD COLUMN "previewGeneratedAt" TIMESTAMP(3),
  ADD COLUMN "previewFileSize"    BIGINT,
  ADD COLUMN "previewAttempts"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "previewQueuedAt"    TIMESTAMP(3);

CREATE INDEX "VideoAsset_previewStatus_idx" ON "VideoAsset"("previewStatus");
