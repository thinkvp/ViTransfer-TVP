-- Add company logo field to Settings (used in email communications)

ALTER TABLE "Settings" ADD COLUMN "companyLogoPath" TEXT;
