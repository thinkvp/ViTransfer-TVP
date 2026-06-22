-- Add enableUploads to Project (master switch for the UPLOADS folder; hides it from admins and clients when false)
ALTER TABLE "Project"
  ADD COLUMN "enableUploads" BOOLEAN NOT NULL DEFAULT TRUE;
