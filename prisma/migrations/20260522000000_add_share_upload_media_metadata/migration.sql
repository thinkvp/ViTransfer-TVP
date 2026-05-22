ALTER TABLE "ShareUploadFile"
ADD COLUMN "mediaDurationSeconds" DOUBLE PRECISION,
ADD COLUMN "mediaWidth" INTEGER,
ADD COLUMN "mediaHeight" INTEGER,
ADD COLUMN "mediaCodec" TEXT;
