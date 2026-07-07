-- AlterTable: generalize single-.eml columns into a multi-attachment JSON column.
-- Safe drop: both columns shipped only in the unreleased 20260705000000_add_ai_assistant.
ALTER TABLE "AiAssistantRequest" ADD COLUMN "attachmentsJson" JSONB;
ALTER TABLE "AiAssistantRequest" DROP COLUMN "emlRaw";
ALTER TABLE "AiAssistantRequest" DROP COLUMN "emailText";
