-- CreateTable
CREATE TABLE "KanbanCardHistory" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorNameSnapshot" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KanbanCardHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KanbanCardHistory_cardId_createdAt_idx" ON "KanbanCardHistory"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "KanbanCardHistory_actorId_idx" ON "KanbanCardHistory"("actorId");

-- AddForeignKey
ALTER TABLE "KanbanCardHistory" ADD CONSTRAINT "KanbanCardHistory_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardHistory" ADD CONSTRAINT "KanbanCardHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
