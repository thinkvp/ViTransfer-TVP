-- Add stable linkage between project recipients and client recipients.

ALTER TABLE "ProjectRecipient"
ADD COLUMN IF NOT EXISTS "clientRecipientId" TEXT;

-- Best-effort backfill: link by (project.clientId + email)
UPDATE "ProjectRecipient" pr
SET "clientRecipientId" = cr.id
FROM "Project" p
JOIN "ClientRecipient" cr
  ON cr."clientId" = p."clientId"
WHERE pr."projectId" = p.id
  AND pr."clientRecipientId" IS NULL
  AND pr.email IS NOT NULL
  AND cr.email IS NOT NULL
  AND LOWER(cr.email) = LOWER(pr.email);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProjectRecipient_clientRecipientId_fkey'
  ) THEN
    ALTER TABLE "ProjectRecipient"
    ADD CONSTRAINT "ProjectRecipient_clientRecipientId_fkey"
    FOREIGN KEY ("clientRecipientId")
    REFERENCES "ClientRecipient"(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ProjectRecipient_clientRecipientId_idx" ON "ProjectRecipient"("clientRecipientId");
