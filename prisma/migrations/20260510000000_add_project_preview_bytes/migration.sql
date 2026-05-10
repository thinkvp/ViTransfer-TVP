-- Add previewBytes column to Project for tracking S3 video preview storage
-- (480p/720p/1080p, thumbnails, timeline sprites/VTT)
-- Reconciled daily by the worker; default 0.

ALTER TABLE "Project" ADD COLUMN "previewBytes" BIGINT NOT NULL DEFAULT 0;
