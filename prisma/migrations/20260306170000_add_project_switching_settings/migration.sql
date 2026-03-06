ALTER TABLE "Project"
ADD COLUMN "allowAuthenticatedProjectSwitching" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Settings"
ADD COLUMN "defaultAllowAuthenticatedProjectSwitching" BOOLEAN NOT NULL DEFAULT true;
