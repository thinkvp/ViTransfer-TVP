-- AlterTable
ALTER TABLE "KanbanCard" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "KanbanCard_archivedAt_idx" ON "KanbanCard"("archivedAt");
