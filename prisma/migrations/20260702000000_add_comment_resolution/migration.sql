-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT;

-- CreateIndex
CREATE INDEX "Comment_projectId_resolvedAt_idx" ON "Comment"("projectId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
