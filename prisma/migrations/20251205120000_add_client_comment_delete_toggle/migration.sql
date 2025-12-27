-- AlterTable
ALTER TABLE "Project" ADD COLUMN "allowClientDeleteComments" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Settings" ADD COLUMN "defaultAllowClientDeleteComments" BOOLEAN NOT NULL DEFAULT FALSE;
