-- AlterTable: AI Assistant customisation settings
ALTER TABLE "Settings" ADD COLUMN "aiReplyDraftsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "aiReplySignature" TEXT;
ALTER TABLE "Settings" ADD COLUMN "aiInstructions" TEXT;
ALTER TABLE "Settings" ADD COLUMN "aiPortfolioJson" TEXT DEFAULT '[]';
