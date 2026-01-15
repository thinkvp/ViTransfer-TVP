-- Add ProjectEmail + ProjectEmailAttachment models for per-project Communication (.eml imports)

-- Create enum for status
DO $$ BEGIN
  CREATE TYPE "ProjectEmailStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'ERROR');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "ProjectEmail" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,

  "rawFileName" TEXT NOT NULL,
  "rawFileSize" BIGINT NOT NULL,
  "rawFileType" TEXT NOT NULL,
  "rawStoragePath" TEXT NOT NULL,

  "subject" TEXT,
  "fromName" TEXT,
  "fromEmail" TEXT,
  "sentAt" TIMESTAMP(3),

  "textBody" TEXT,
  "htmlBody" TEXT,

  "attachmentsCount" INTEGER NOT NULL DEFAULT 0,
  "hasAttachments" BOOLEAN NOT NULL DEFAULT FALSE,

  "status" "ProjectEmailStatus" NOT NULL DEFAULT 'UPLOADING',
  "errorMessage" TEXT,

  "uploadedBy" TEXT,
  "uploadedByName" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "ProjectEmailAttachment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectEmailId" TEXT NOT NULL,

  "fileName" TEXT NOT NULL,
  "fileSize" BIGINT NOT NULL,
  "fileType" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,

  "isInline" BOOLEAN NOT NULL DEFAULT FALSE,
  "contentId" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectEmailAttachment_projectEmailId_fkey" FOREIGN KEY ("projectEmailId") REFERENCES "ProjectEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "ProjectEmail"
  ADD CONSTRAINT "ProjectEmail_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ProjectEmail_projectId_idx" ON "ProjectEmail"("projectId");
CREATE INDEX "ProjectEmail_projectId_sentAt_idx" ON "ProjectEmail"("projectId", "sentAt");
CREATE INDEX "ProjectEmail_projectId_createdAt_idx" ON "ProjectEmail"("projectId", "createdAt");

CREATE INDEX "ProjectEmailAttachment_projectEmailId_idx" ON "ProjectEmailAttachment"("projectEmailId");
