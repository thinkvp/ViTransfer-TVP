-- Repair migration for environments where 20260108013710_add_clients failed
-- Safe/idempotent: uses IF EXISTS / IF NOT EXISTS / conditional constraints

-- Ensure Project.clientId exists
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "clientId" TEXT;

-- Ensure Client tables exist
CREATE TABLE IF NOT EXISTS "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClientRecipient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "displayColor" VARCHAR(7),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "receiveNotifications" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientRecipient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClientFile" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "category" TEXT,
    "uploadedBy" TEXT,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientFile_pkey" PRIMARY KEY ("id")
);

-- Indexes (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "Client_name_key" ON "Client"("name");
CREATE INDEX IF NOT EXISTS "Client_deletedAt_idx" ON "Client"("deletedAt");
CREATE INDEX IF NOT EXISTS "Client_name_idx" ON "Client"("name");

CREATE INDEX IF NOT EXISTS "ClientRecipient_clientId_idx" ON "ClientRecipient"("clientId");
CREATE INDEX IF NOT EXISTS "ClientRecipient_clientId_email_idx" ON "ClientRecipient"("clientId", "email");

CREATE INDEX IF NOT EXISTS "ClientFile_clientId_idx" ON "ClientFile"("clientId");
CREATE INDEX IF NOT EXISTS "ClientFile_clientId_category_idx" ON "ClientFile"("clientId", "category");

-- Comment index (safe)
CREATE INDEX IF NOT EXISTS "Comment_recipientId_idx" ON "Comment"("recipientId");

-- Foreign keys (conditional)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ClientRecipient_clientId_fkey') THEN
    ALTER TABLE "ClientRecipient" ADD CONSTRAINT "ClientRecipient_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ClientFile_clientId_fkey') THEN
    ALTER TABLE "ClientFile" ADD CONSTRAINT "ClientFile_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Project_clientId_fkey') THEN
    ALTER TABLE "Project" ADD CONSTRAINT "Project_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- If Role exists, align defaults with current Prisma model (safe to run even if defaults already dropped)
DO $$
BEGIN
  IF to_regclass('public."Role"') IS NOT NULL THEN
    ALTER TABLE "Role"
      ALTER COLUMN "permissions" DROP DEFAULT,
      ALTER COLUMN "updatedAt" DROP DEFAULT;
  END IF;
END $$;
