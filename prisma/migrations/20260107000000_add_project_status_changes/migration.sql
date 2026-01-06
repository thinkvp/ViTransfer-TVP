-- Add ProjectStatusChange table for audit trail of project status transitions

CREATE TABLE "ProjectStatusChange" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "previousStatus" "ProjectStatus" NOT NULL,
    "currentStatus" "ProjectStatus" NOT NULL,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectStatusChange_pkey" PRIMARY KEY ("id")
);

-- Foreign key: project
ALTER TABLE "ProjectStatusChange" ADD CONSTRAINT "ProjectStatusChange_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign key: user (optional)
ALTER TABLE "ProjectStatusChange" ADD CONSTRAINT "ProjectStatusChange_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "ProjectStatusChange_projectId_createdAt_idx" ON "ProjectStatusChange"("projectId", "createdAt");
