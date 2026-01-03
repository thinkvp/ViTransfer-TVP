-- Add snapshot display colour to comments so highlight colours remain stable
-- even if the linked user/recipient is later deleted.

ALTER TABLE "Comment"
ADD COLUMN IF NOT EXISTS "displayColorSnapshot" VARCHAR(7);

-- Best-effort backfill from existing relations.
-- If a comment is linked to a user/recipient, copy their displayColor into the snapshot.
UPDATE "Comment" c
SET "displayColorSnapshot" = u."displayColor"
FROM "User" u
WHERE c."displayColorSnapshot" IS NULL
  AND c."isInternal" = TRUE
  AND c."userId" IS NOT NULL
  AND c."userId" = u."id"
  AND u."displayColor" IS NOT NULL;

UPDATE "Comment" c
SET "displayColorSnapshot" = r."displayColor"
FROM "ProjectRecipient" r
WHERE c."displayColorSnapshot" IS NULL
  AND c."isInternal" = FALSE
  AND c."recipientId" IS NOT NULL
  AND c."recipientId" = r."id"
  AND r."displayColor" IS NOT NULL;
