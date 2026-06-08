-- AlterTable: VideoAsset — add timeline preview columns for video-type assets
ALTER TABLE "VideoAsset" ADD COLUMN "mediaDurationSeconds" DOUBLE PRECISION;
ALTER TABLE "VideoAsset" ADD COLUMN "mediaWidth" INTEGER;
ALTER TABLE "VideoAsset" ADD COLUMN "mediaHeight" INTEGER;
ALTER TABLE "VideoAsset" ADD COLUMN "timelinePreviewsReady" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VideoAsset" ADD COLUMN "timelinePreviewVttPath" TEXT;
ALTER TABLE "VideoAsset" ADD COLUMN "timelinePreviewSpritesPath" TEXT;
ALTER TABLE "VideoAsset" ADD COLUMN "processingPhase" TEXT;
ALTER TABLE "VideoAsset" ADD COLUMN "processingProgress" DOUBLE PRECISION DEFAULT 0;

-- AlterTable: ShareUploadFile — add timeline preview columns for video-type uploads
ALTER TABLE "ShareUploadFile" ADD COLUMN "timelinePreviewsReady" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShareUploadFile" ADD COLUMN "timelinePreviewVttPath" TEXT;
ALTER TABLE "ShareUploadFile" ADD COLUMN "timelinePreviewSpritesPath" TEXT;
ALTER TABLE "ShareUploadFile" ADD COLUMN "processingPhase" TEXT;
ALTER TABLE "ShareUploadFile" ADD COLUMN "processingProgress" DOUBLE PRECISION DEFAULT 0;
