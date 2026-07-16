-- Manual subtitle-edit attribution (latest cue edit only)
ALTER TABLE "Video"
  ADD COLUMN "subtitlesEditedAt" TIMESTAMP(3),
  ADD COLUMN "subtitlesEditedById" TEXT,
  ADD COLUMN "subtitlesEditedByRecipientId" TEXT,
  ADD COLUMN "subtitlesEditedByName" TEXT;
