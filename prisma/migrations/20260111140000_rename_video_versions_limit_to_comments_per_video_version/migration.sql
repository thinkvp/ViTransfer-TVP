-- Rename safeguard limit field to reflect comment-based cap
ALTER TABLE "SecuritySettings"
RENAME COLUMN "maxVideoVersionsPerVideo" TO "maxCommentsPerVideoVersion";
