-- CreateTable
CREATE TABLE "FolderRenameJob" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "oldPrefix" TEXT NOT NULL,
    "newPrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "totalObjects" INTEGER NOT NULL DEFAULT 0,
    "copiedObjects" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "copiedBytes" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FolderRenameJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FolderRenameJob_status_idx" ON "FolderRenameJob"("status");

-- CreateIndex
CREATE INDEX "FolderRenameJob_entityType_entityId_idx" ON "FolderRenameJob"("entityType", "entityId");
