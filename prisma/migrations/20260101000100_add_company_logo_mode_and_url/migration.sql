-- Add company logo mode and optional hosted logo URL

ALTER TABLE "Settings"
ADD COLUMN "companyLogoMode" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN "companyLogoUrl" TEXT;
