-- Add global toggle for email tracking pixels
ALTER TABLE "Settings" ADD COLUMN "emailTrackingPixelsEnabled" BOOLEAN NOT NULL DEFAULT TRUE;
