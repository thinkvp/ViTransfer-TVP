-- Add internal-only ProjectFile uploads

CREATE TABLE "ProjectFile" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileSize" BIGINT NOT NULL,
  "fileType" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "category" TEXT,
  "uploadedBy" TEXT,
  "uploadedByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectFile_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProjectFile" ADD CONSTRAINT "ProjectFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ProjectFile_projectId_idx" ON "ProjectFile"("projectId");
CREATE INDEX "ProjectFile_projectId_category_idx" ON "ProjectFile"("projectId", "category");
