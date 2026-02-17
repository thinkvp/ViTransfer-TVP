-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "defaultTheme" TEXT NOT NULL DEFAULT 'DARK';
ALTER TABLE "Settings" ADD COLUMN "allowThemeToggle" BOOLEAN NOT NULL DEFAULT true;
