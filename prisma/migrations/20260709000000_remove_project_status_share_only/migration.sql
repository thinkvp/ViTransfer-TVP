-- Remove the SHARE_ONLY value from the ProjectStatus enum.
-- Postgres cannot drop an enum value in place, so recreate the type without it.
-- No rows use SHARE_ONLY (the status was never used in production), so the
-- USING casts below cannot fail.

ALTER TYPE "ProjectStatus" RENAME TO "ProjectStatus_old";

CREATE TYPE "ProjectStatus" AS ENUM ('IN_REVIEW', 'ON_HOLD', 'APPROVED', 'NOT_STARTED', 'IN_PROGRESS', 'REVIEWED', 'CLOSED');

ALTER TABLE "Project" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Project" ALTER COLUMN "status" TYPE "ProjectStatus" USING ("status"::text::"ProjectStatus");
ALTER TABLE "Project" ALTER COLUMN "status" SET DEFAULT 'NOT_STARTED';

ALTER TABLE "ProjectStatusChange" ALTER COLUMN "previousStatus" TYPE "ProjectStatus" USING ("previousStatus"::text::"ProjectStatus");
ALTER TABLE "ProjectStatusChange" ALTER COLUMN "currentStatus" TYPE "ProjectStatus" USING ("currentStatus"::text::"ProjectStatus");

DROP TYPE "ProjectStatus_old";
