-- Add dedupeKey for idempotent ProjectEmailEvent logging
ALTER TABLE "ProjectEmailEvent" ADD COLUMN "dedupeKey" TEXT;

-- Unique index to prevent duplicate events for the same dedupeKey
CREATE UNIQUE INDEX "ProjectEmailEvent_dedupeKey_key" ON "ProjectEmailEvent"("dedupeKey");
