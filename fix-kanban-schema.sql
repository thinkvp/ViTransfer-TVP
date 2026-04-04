-- Add KanbanCardMember table
CREATE TABLE IF NOT EXISTS "KanbanCardMember" (
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KanbanCardMember_pkey" PRIMARY KEY ("cardId","userId")
);

CREATE INDEX IF NOT EXISTS "KanbanCardMember_userId_idx" ON "KanbanCardMember"("userId");

-- Add foreign keys (ignore if they already exist)
DO $$ BEGIN
  ALTER TABLE "KanbanCardMember" ADD CONSTRAINT "KanbanCardMember_cardId_fkey"
    FOREIGN KEY ("cardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "KanbanCardMember" ADD CONSTRAINT "KanbanCardMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add dueDate index if missing
CREATE INDEX IF NOT EXISTS "KanbanCard_dueDate_idx" ON "KanbanCard"("dueDate");

-- Migrate existing assignedToId data to KanbanCardMember
INSERT INTO "KanbanCardMember" ("cardId", "userId", "createdAt")
SELECT "id", "assignedToId", NOW()
FROM "KanbanCard"
WHERE "assignedToId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Drop the old column
ALTER TABLE "KanbanCard" DROP COLUMN IF EXISTS "assignedToId";
