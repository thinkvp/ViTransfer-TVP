-- Marking a version Reviewed from the admin project page ("Mark as Reviewed") now locks its
-- client feedback, the same as the client's Request Next Version. Versions an admin marked
-- Reviewed before this change never had that lock applied, so apply it here.
--
-- Only feedback that existed when the version was marked is locked; comments added since stay
-- open, matching what the live flow does. Client-requested versions are already locked, so
-- this is a no-op for them. Internal (studio) comments are never locked.
UPDATE "Comment" c
SET "lockedAt" = v."revisionRequestedAt"
FROM "Video" v
WHERE c."videoId" = v."id"
  AND v."revisionRequestedAt" IS NOT NULL
  AND c."isInternal" = false
  AND c."lockedAt" IS NULL
  AND c."createdAt" <= v."revisionRequestedAt";
