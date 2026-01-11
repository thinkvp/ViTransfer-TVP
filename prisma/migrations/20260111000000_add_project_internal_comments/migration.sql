-- Add ProjectInternalComment table for internal-only project comments (with reply threading)

CREATE TABLE "ProjectInternalComment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "authorNameSnapshot" TEXT,
    "displayColorSnapshot" VARCHAR(7),
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "ProjectInternalComment_pkey" PRIMARY KEY ("id")
);

-- FK: project
ALTER TABLE "ProjectInternalComment"
ADD CONSTRAINT "ProjectInternalComment_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: user
ALTER TABLE "ProjectInternalComment"
ADD CONSTRAINT "ProjectInternalComment_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: parent
ALTER TABLE "ProjectInternalComment"
ADD CONSTRAINT "ProjectInternalComment_parentId_fkey"
FOREIGN KEY ("parentId") REFERENCES "ProjectInternalComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "ProjectInternalComment_projectId_idx" ON "ProjectInternalComment"("projectId");
CREATE INDEX "ProjectInternalComment_projectId_createdAt_idx" ON "ProjectInternalComment"("projectId", "createdAt");
CREATE INDEX "ProjectInternalComment_parentId_idx" ON "ProjectInternalComment"("parentId");
CREATE INDEX "ProjectInternalComment_userId_idx" ON "ProjectInternalComment"("userId");
