-- Add accent text mode for button text on accent-coloured backgrounds (LIGHT = white, DARK = almost-black)
ALTER TABLE "Settings" ADD COLUMN "accentTextMode" TEXT NOT NULL DEFAULT 'LIGHT';

-- Add email header background colour (nullable; NULL = use default #1F1F1F)
ALTER TABLE "Settings" ADD COLUMN "emailHeaderColor" TEXT;

-- Add email header text mode (LIGHT = white, DARK = almost-black)
ALTER TABLE "Settings" ADD COLUMN "emailHeaderTextMode" TEXT NOT NULL DEFAULT 'LIGHT';
