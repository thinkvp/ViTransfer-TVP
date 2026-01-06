-- Set default status for new projects
--
-- This must be a separate migration from enum value additions because Postgres
-- requires new enum values to be committed before they can be used.
ALTER TABLE "Project" ALTER COLUMN "status" SET DEFAULT 'NOT_STARTED'::"ProjectStatus";
