-- CreateTable
CREATE TABLE "UserProjectViewSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "visibleSections" JSONB NOT NULL DEFAULT '{"sales":true,"keyDates":true,"externalCommunication":true,"users":true,"projectFiles":true,"projectData":true}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProjectViewSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserProjectViewSettings_userId_idx" ON "UserProjectViewSettings"("userId");

-- CreateIndex
CREATE INDEX "UserProjectViewSettings_projectId_idx" ON "UserProjectViewSettings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProjectViewSettings_userId_projectId_key" ON "UserProjectViewSettings"("userId", "projectId");

-- AddForeignKey
ALTER TABLE "UserProjectViewSettings" ADD CONSTRAINT "UserProjectViewSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProjectViewSettings" ADD CONSTRAINT "UserProjectViewSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
