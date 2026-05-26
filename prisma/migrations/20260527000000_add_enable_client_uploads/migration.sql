-- Add enableClientUploads to Project (controls UPLOADS folder visibility for clients)
ALTER TABLE "Project"
  ADD COLUMN "enableClientUploads" BOOLEAN NOT NULL DEFAULT TRUE;

-- Add defaultEnableClientUploads to Settings
ALTER TABLE "Settings"
  ADD COLUMN "defaultEnableClientUploads" BOOLEAN NOT NULL DEFAULT TRUE;
