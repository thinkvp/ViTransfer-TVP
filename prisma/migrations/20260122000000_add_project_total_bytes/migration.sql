-- Add precomputed project storage total (bytes)

ALTER TABLE "Project" ADD COLUMN "totalBytes" BIGINT NOT NULL DEFAULT 0;
