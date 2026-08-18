-- Optional phone number on client contacts / project recipients.
-- Admin-only field: never collected or shown on the client share page.
ALTER TABLE "ClientRecipient" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(20);
ALTER TABLE "ProjectRecipient" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(20);
