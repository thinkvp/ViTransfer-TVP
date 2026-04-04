-- 1. Comment.videoId → proper FK with cascade delete
-- Add foreign key constraint from Comment.videoId to Video.id
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add composite index for efficient video-scoped comment queries
CREATE INDEX "Comment_projectId_videoId_idx" ON "Comment"("projectId", "videoId");

-- 2. NotificationQueue.type → enum
-- Create the NotificationQueueType enum
CREATE TYPE "NotificationQueueType" AS ENUM ('CLIENT_COMMENT', 'ADMIN_REPLY', 'INTERNAL_COMMENT', 'TASK_COMMENT');

-- Convert the plain String column to the enum type
ALTER TABLE "NotificationQueue" ALTER COLUMN "type" TYPE "NotificationQueueType" USING "type"::"NotificationQueueType";

-- 3. Remove UserRole enum and User.role column
-- Drop the column first, then the enum
ALTER TABLE "User" DROP COLUMN "role";
DROP TYPE "UserRole";
