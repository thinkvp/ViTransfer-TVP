-- Add customizable display colors for admins and recipients,
-- and link client comments to a specific project recipient.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "displayColor" VARCHAR(7);

ALTER TABLE "ProjectRecipient" ADD COLUMN IF NOT EXISTS "displayColor" VARCHAR(7);

ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "recipientId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'Comment_recipientId_fkey'
  ) THEN
    ALTER TABLE "Comment"
      ADD CONSTRAINT "Comment_recipientId_fkey"
      FOREIGN KEY ("recipientId") REFERENCES "ProjectRecipient"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Best-effort backfill: map existing client comments to a recipient by email within the same project.
UPDATE "Comment" c
SET "recipientId" = r."id"
FROM "ProjectRecipient" r
WHERE c."recipientId" IS NULL
  AND c."isInternal" = FALSE
  AND c."authorEmail" IS NOT NULL
  AND r."projectId" = c."projectId"
  AND r."email" IS NOT NULL
  AND lower(r."email") = lower(c."authorEmail");
