-- General (non-timecoded) comments.
--
-- A comment with a NULL timecode is "general": feedback about the whole video rather
-- than a moment in it. The share-page composer picks the mode with a Timecoded/General
-- segmented control; timecoded stays the default.
--
-- Existing rows all carry a real timecode, so this is a widening change with no backfill.
ALTER TABLE "Comment" ALTER COLUMN "timecode" DROP NOT NULL;
