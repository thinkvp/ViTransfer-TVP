-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SalesDocShareType" AS ENUM ('QUOTE', 'INVOICE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SalesDocumentShare" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "type" "SalesDocShareType" NOT NULL,
  "docId" TEXT NOT NULL,
  "docNumber" TEXT NOT NULL,
  "docJson" JSONB NOT NULL,
  "settingsJson" JSONB NOT NULL,
  "clientName" TEXT,
  "projectTitle" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastAccessedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "SalesDocumentShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SalesDocumentShare_token_key" ON "SalesDocumentShare"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "SalesDocumentShare_type_docId_key" ON "SalesDocumentShare"("type", "docId");
