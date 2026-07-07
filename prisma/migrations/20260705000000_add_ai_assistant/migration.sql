-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "aiProvider" TEXT DEFAULT 'NONE';
ALTER TABLE "Settings" ADD COLUMN "aiOllamaUrl" TEXT;
ALTER TABLE "Settings" ADD COLUMN "aiOllamaModel" TEXT;
ALTER TABLE "Settings" ADD COLUMN "aiAnthropicModel" TEXT DEFAULT 'claude-opus-4-8';
ALTER TABLE "Settings" ADD COLUMN "aiAnthropicApiKey" TEXT;

-- CreateTable
CREATE TABLE "AiAssistantRequest" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "prompt" TEXT NOT NULL,
    "emlRaw" TEXT,
    "emailText" TEXT,
    "contextJson" JSONB,
    "resultJson" JSONB,
    "error" TEXT,
    "provider" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiAssistantRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAssistantRequest_status_createdAt_idx" ON "AiAssistantRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AiAssistantRequest_createdById_createdAt_idx" ON "AiAssistantRequest"("createdById", "createdAt");

-- AddForeignKey
ALTER TABLE "AiAssistantRequest" ADD CONSTRAINT "AiAssistantRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
