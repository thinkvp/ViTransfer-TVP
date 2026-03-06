-- Add notes and file attachments for internal users
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE TABLE IF NOT EXISTS "UserFile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileSize" BIGINT NOT NULL,
  "fileType" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "category" TEXT,
  "uploadedBy" TEXT,
  "uploadedByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "UserFile_userId_idx" ON "UserFile"("userId");
CREATE INDEX IF NOT EXISTS "UserFile_userId_category_idx" ON "UserFile"("userId", "category");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'UserFile_userId_fkey'
  ) THEN
    ALTER TABLE "UserFile"
      ADD CONSTRAINT "UserFile_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
