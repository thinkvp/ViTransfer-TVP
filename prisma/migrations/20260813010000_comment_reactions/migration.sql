-- Emoji reactions on share-page video comments (top-level comments and replies).
-- Reactors are attributable only: an admin User or a project ProjectRecipient.

CREATE TABLE "CommentReaction" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "recipientId" TEXT,

    CONSTRAINT "CommentReaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommentReaction_commentId_idx" ON "CommentReaction"("commentId");
CREATE INDEX "CommentReaction_userId_idx" ON "CommentReaction"("userId");
CREATE INDEX "CommentReaction_recipientId_idx" ON "CommentReaction"("recipientId");

-- One reaction per emoji per identity. Postgres treats NULLs as distinct, so the admin
-- constraint only binds rows with userId set and the recipient constraint only binds rows
-- with recipientId set.
CREATE UNIQUE INDEX "CommentReaction_commentId_emoji_userId_key" ON "CommentReaction"("commentId", "emoji", "userId");
CREATE UNIQUE INDEX "CommentReaction_commentId_emoji_recipientId_key" ON "CommentReaction"("commentId", "emoji", "recipientId");

ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "ProjectRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-project client permission for reacting (separate from allowClientDeleteComments,
-- which already doubles as the client edit permission).
ALTER TABLE "Project"
  ADD COLUMN "allowClientReactions" BOOLEAN NOT NULL DEFAULT true;
