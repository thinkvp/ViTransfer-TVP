-- Optional per-version client feedback deadline + reminder settings.
ALTER TABLE "Video" ADD COLUMN "feedbackDueDate" VARCHAR(10);
ALTER TABLE "Video" ADD COLUMN "feedbackDueExtendedAt" TIMESTAMP(3);
ALTER TABLE "Video" ADD COLUMN "feedbackDueLastReminderAt" TIMESTAMP(3);
CREATE INDEX "Video_feedbackDueDate_idx" ON "Video"("feedbackDueDate");

ALTER TABLE "Settings" ADD COLUMN "clientEmailFeedbackReminders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "feedbackReminderDaysBefore" INTEGER[] DEFAULT ARRAY[1]::INTEGER[];
ALTER TABLE "Settings" ADD COLUMN "feedbackReminderTime" TEXT NOT NULL DEFAULT '09:00';
