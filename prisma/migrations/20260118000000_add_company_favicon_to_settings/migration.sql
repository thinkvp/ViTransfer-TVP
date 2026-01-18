-- Add company favicon fields to Settings
--
-- Reuse the existing CompanyLogoMode enum (NONE | UPLOAD | LINK) to keep schema consistent.

ALTER TABLE "Settings"
  ADD COLUMN "companyFaviconMode" "CompanyLogoMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "companyFaviconPath" TEXT,
  ADD COLUMN "companyFaviconUrl" TEXT;
