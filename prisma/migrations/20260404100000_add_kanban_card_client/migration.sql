-- AlterTable
ALTER TABLE "KanbanCard" ADD COLUMN "clientId" TEXT;

-- AddForeignKey
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "KanbanCard_clientId_idx" ON "KanbanCard"("clientId");
