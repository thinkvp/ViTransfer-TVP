-- Approving a video now locks the client feedback on it instead of closing the comment box
-- (the same "locked in" semantics as Request Next Version). Existing feedback on videos that
-- were approved before this change was frozen by the old UI gate, so freeze it for real here
-- — otherwise it would suddenly become editable/deletable again by share sessions.
--
-- Locks cover every version of an approved video's name group, matching
-- lockCommentsForApprovedVideo(). Internal (studio) comments are never locked.
UPDATE "Comment" c
SET "lockedAt" = COALESCE(v."approvedAt", c."updatedAt", c."createdAt")
FROM "Video" v
WHERE c."videoId" = v."id"
  AND c."isInternal" = false
  AND c."lockedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "Video" sibling
    WHERE sibling."projectId" = v."projectId"
      AND sibling."name" = v."name"
      AND sibling."approved" = true
  );

-- Projects signed off at the project level without any individually approved video were also
-- comment-closed by the old UI. Freeze that feedback too.
UPDATE "Comment" c
SET "lockedAt" = COALESCE(p."approvedAt", c."updatedAt", c."createdAt")
FROM "Project" p
WHERE c."projectId" = p."id"
  AND p."status" = 'APPROVED'
  AND c."isInternal" = false
  AND c."lockedAt" IS NULL;
