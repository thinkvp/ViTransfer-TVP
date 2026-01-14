-- Add expiresAt to SalesDocumentShare
ALTER TABLE "SalesDocumentShare" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- Optional index to help with cleanup queries
CREATE INDEX IF NOT EXISTS "SalesDocumentShare_expiresAt_idx" ON "SalesDocumentShare"("expiresAt");
