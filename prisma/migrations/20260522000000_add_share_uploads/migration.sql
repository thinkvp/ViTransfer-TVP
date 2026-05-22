-- CreateTable
CREATE TABLE "ShareUploadFolder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareUploadFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareUploadFile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "folderRelativePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "category" TEXT,
    "uploadedById" TEXT,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareUploadFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShareUploadFolder_projectId_relativePath_key" ON "ShareUploadFolder"("projectId", "relativePath");

-- CreateIndex
CREATE INDEX "ShareUploadFolder_projectId_folderName_idx" ON "ShareUploadFolder"("projectId", "folderName");

-- CreateIndex
CREATE INDEX "ShareUploadFile_projectId_folderRelativePath_idx" ON "ShareUploadFile"("projectId", "folderRelativePath");

-- CreateIndex
CREATE INDEX "ShareUploadFile_projectId_category_idx" ON "ShareUploadFile"("projectId", "category");

-- AddForeignKey
ALTER TABLE "ShareUploadFolder" ADD CONSTRAINT "ShareUploadFolder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareUploadFile" ADD CONSTRAINT "ShareUploadFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
