-- Add application safeguard limits to SecuritySettings
ALTER TABLE "SecuritySettings"
ADD COLUMN     "maxInternalCommentsPerProject" INTEGER NOT NULL DEFAULT 250,
ADD COLUMN     "maxVideoVersionsPerVideo" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "maxProjectRecipients" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "maxProjectFilesPerProject" INTEGER NOT NULL DEFAULT 50;
