-- AlterTable: add optional range-end timecode to Comment
ALTER TABLE "Comment" ADD COLUMN "timecodeEnd" TEXT;
