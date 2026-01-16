-- Add per-user calendar subscription token

ALTER TABLE "User" ADD COLUMN "calendarFeedToken" TEXT;

-- Unique token so feeds can resolve a single user.
-- Postgres allows multiple NULLs in a unique index.
CREATE UNIQUE INDEX "User_calendarFeedToken_key" ON "User"("calendarFeedToken");
