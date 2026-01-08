-- Add customizable Roles for internal users

-- Create Role table
CREATE TABLE IF NOT EXISTS "Role" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "isSystemAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
  "permissions" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- Unique role names
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'Role_name_key'
  ) THEN
    ALTER TABLE "Role" ADD CONSTRAINT "Role_name_key" UNIQUE ("name");
  END IF;
END $$;

-- Add appRoleId to User and backfill
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "appRoleId" TEXT;

-- Ensure Admin role exists (fixed id for stable default)
INSERT INTO "Role" ("id", "name", "isSystemAdmin", "permissions")
VALUES (
  'role_admin',
  'Admin',
  TRUE,
  jsonb_build_object(
    'menuVisibility', jsonb_build_object(
      'projects', TRUE,
      'settings', TRUE,
      'users', TRUE,
      'integrations', TRUE,
      'security', TRUE,
      'analytics', TRUE
    ),
    'projectVisibility', jsonb_build_object(
      'statuses', jsonb_build_array('NOT_STARTED','IN_REVIEW','ON_HOLD','SHARE_ONLY','APPROVED','CLOSED')
    ),
    'actions', jsonb_build_object(
      'accessProjectSettings', TRUE,
      'changeProjectSettings', TRUE,
      'sendNotificationsToRecipients', TRUE,
      'makeCommentsOnProjects', TRUE,
      'changeProjectStatuses', TRUE,
      'deleteProjects', TRUE,
      'viewAnalytics', TRUE
    )
  )
)
ON CONFLICT ("id") DO NOTHING;

-- Backfill all existing users to Admin app role
UPDATE "User"
SET "appRoleId" = 'role_admin'
WHERE "appRoleId" IS NULL;

-- Make appRoleId required + add FK
DO $$
BEGIN
  -- Add FK if missing
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'User_appRoleId_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_appRoleId_fkey"
      FOREIGN KEY ("appRoleId") REFERENCES "Role"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- Enforce NOT NULL (safe after backfill)
  ALTER TABLE "User" ALTER COLUMN "appRoleId" SET NOT NULL;
END $$;
