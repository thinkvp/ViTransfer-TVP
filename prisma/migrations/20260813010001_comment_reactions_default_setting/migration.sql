-- Global default for the per-project allowClientReactions flag (applied to new projects).
ALTER TABLE "Settings"
  ADD COLUMN "defaultAllowClientReactions" BOOLEAN NOT NULL DEFAULT true;
