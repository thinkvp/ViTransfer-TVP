-- Add client file upload toggle to Project model
ALTER TABLE "Project" ADD COLUMN "allowClientUploadFiles" BOOLEAN NOT NULL DEFAULT FALSE;

-- Add client file upload toggle to Settings model  
ALTER TABLE "Settings" ADD COLUMN "defaultAllowClientUploadFiles" BOOLEAN NOT NULL DEFAULT FALSE;

-- Create CommentFile model to track uploaded files with comments
CREATE TABLE "CommentFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "commentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT "CommentFile_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment" ("id") ON DELETE CASCADE,
    CONSTRAINT "CommentFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE
);

-- Create indexes for CommentFile
CREATE INDEX "CommentFile_commentId_idx" ON "CommentFile"("commentId");
CREATE INDEX "CommentFile_projectId_idx" ON "CommentFile"("projectId");
