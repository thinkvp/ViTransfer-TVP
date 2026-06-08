-- Composite index for worker preview-generation polling:
--   SELECT ... FROM "ShareUploadFile"
--   WHERE "projectId" = ? AND "previewStatus" IN ('PENDING', 'PROCESSING')
CREATE INDEX CONCURRENTLY "ShareUploadFile_projectId_previewStatus_idx"
  ON "ShareUploadFile" ("projectId", "previewStatus");
