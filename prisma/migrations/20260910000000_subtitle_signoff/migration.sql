-- Caption sign-off: an admin has proof-read a version's cues.
-- Set only by the explicit "Mark checked" action; cleared by every wholesale cue write.
ALTER TABLE "Video"
  ADD COLUMN "subtitlesApprovedAt" TIMESTAMP(3),
  ADD COLUMN "subtitlesApprovedById" TEXT,
  ADD COLUMN "subtitlesApprovedByName" TEXT;

-- Withhold the caption .srt from client downloads until it is signed off.
-- Defaults ON: existing videos have no sign-off, so unchecked captions stop
-- being delivered as a client asset until someone marks them checked.
ALTER TABLE "Settings"
  ADD COLUMN "subtitlesRequireApprovalForDownload" BOOLEAN NOT NULL DEFAULT true;
