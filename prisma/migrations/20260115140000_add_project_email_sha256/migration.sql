-- Add rawSha256 to ProjectEmail for duplicate detection

ALTER TABLE "ProjectEmail" ADD COLUMN "rawSha256" VARCHAR(64);

-- Prevent duplicates per project (NULLs allowed for legacy rows)
CREATE UNIQUE INDEX "ProjectEmail_projectId_rawSha256_key" ON "ProjectEmail"("projectId", "rawSha256");
