-- Fix TIMELINE_SPRITES paths: the legacy backfill stored paths without the
-- timeline-previews/ subfolder, but all path builders and the content-delivery
-- route expect it.  Append /timeline-previews to directory paths that don't
-- already contain it.
UPDATE "StoredFile"
SET "storagePath" = "storagePath" || '/timeline-previews'
WHERE "fileRole" = 'TIMELINE_SPRITES'
  AND "storagePath" NOT LIKE '%/timeline-previews';

-- Fix TIMELINE_VTT paths: VTT files live inside the timeline-previews/
-- subfolder alongside the sprite images.  Insert /timeline-previews before
-- the trailing /index.vtt.
UPDATE "StoredFile"
SET "storagePath" = REPLACE("storagePath", '/index.vtt', '/timeline-previews/index.vtt')
WHERE "fileRole" = 'TIMELINE_VTT'
  AND "storagePath" LIKE '%/index.vtt'
  AND "storagePath" NOT LIKE '%/timeline-previews/index.vtt';
