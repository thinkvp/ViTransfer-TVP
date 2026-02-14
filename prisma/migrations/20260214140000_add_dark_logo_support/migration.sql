-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "darkLogoEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "darkLogoMode" "CompanyLogoMode" NOT NULL DEFAULT 'NONE';
ALTER TABLE "Settings" ADD COLUMN "darkLogoPath" TEXT;
ALTER TABLE "Settings" ADD COLUMN "darkLogoUrl" TEXT;
