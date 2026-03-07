-- Add active flag to User table (default true)

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;

-- Allow efficient filtering and auth checks for internal users
CREATE INDEX IF NOT EXISTS "User_active_idx" ON "User"("active");