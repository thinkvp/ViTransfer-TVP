-- Add per-assigned-user notification toggle on projects
ALTER TABLE "ProjectUser"
ADD COLUMN IF NOT EXISTS "receiveNotifications" BOOLEAN NOT NULL DEFAULT TRUE;

-- Track internal-comment summary last-send (uses same admin schedule/time/day)
ALTER TABLE "Settings"
ADD COLUMN IF NOT EXISTS "lastInternalCommentNotificationSent" TIMESTAMP(3);

-- Backfill: ensure all system admins are assigned to all projects (to satisfy "at least 1 admin" and default behavior)
INSERT INTO "ProjectUser" ("projectId", "userId")
SELECT p."id", u."id"
FROM "Project" p
CROSS JOIN "User" u
JOIN "Role" r ON r."id" = u."appRoleId"
WHERE r."isSystemAdmin" = TRUE
AND NOT EXISTS (
  SELECT 1
  FROM "ProjectUser" pu
  WHERE pu."projectId" = p."id" AND pu."userId" = u."id"
);
