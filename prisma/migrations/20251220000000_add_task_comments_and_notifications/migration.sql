-- AlterTable: Make NotificationQueue.projectId optional
ALTER TABLE "NotificationQueue" ALTER COLUMN "projectId" DROP NOT NULL;

-- AlterTable: Add kanbanCardId to NotificationQueue
ALTER TABLE "NotificationQueue" ADD COLUMN "kanbanCardId" TEXT;

-- AlterTable: Add receiveNotifications to KanbanCardMember
ALTER TABLE "KanbanCardMember" ADD COLUMN "receiveNotifications" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable: KanbanCardComment
CREATE TABLE "KanbanCardComment" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT,
    "authorNameSnapshot" TEXT,
    "displayColorSnapshot" VARCHAR(7),
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "KanbanCardComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KanbanCardComment_cardId_idx" ON "KanbanCardComment"("cardId");

-- CreateIndex
CREATE INDEX "KanbanCardComment_cardId_createdAt_idx" ON "KanbanCardComment"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "KanbanCardComment_parentId_idx" ON "KanbanCardComment"("parentId");

-- CreateIndex
CREATE INDEX "KanbanCardComment_userId_idx" ON "KanbanCardComment"("userId");

-- CreateIndex
CREATE INDEX "NotificationQueue_kanbanCardId_idx" ON "NotificationQueue"("kanbanCardId");

-- AddForeignKey
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_kanbanCardId_fkey" FOREIGN KEY ("kanbanCardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardComment" ADD CONSTRAINT "KanbanCardComment_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardComment" ADD CONSTRAINT "KanbanCardComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanCardComment" ADD CONSTRAINT "KanbanCardComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "KanbanCardComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
