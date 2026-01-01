-- Fix companyLogoMode column type
--
-- Previous migration added Settings.companyLogoMode as TEXT, but Prisma schema defines it as an enum.
-- This migration creates the enum type (if needed) and converts the column.

DO $$
BEGIN
  CREATE TYPE "CompanyLogoMode" AS ENUM ('NONE', 'UPLOAD', 'LINK');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Settings"
  ALTER COLUMN "companyLogoMode" DROP DEFAULT;

ALTER TABLE "Settings"
  ALTER COLUMN "companyLogoMode" TYPE "CompanyLogoMode"
  USING "companyLogoMode"::"CompanyLogoMode";

ALTER TABLE "Settings"
  ALTER COLUMN "companyLogoMode" SET DEFAULT 'NONE';
