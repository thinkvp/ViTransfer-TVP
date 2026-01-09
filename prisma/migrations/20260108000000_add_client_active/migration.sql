-- Add active flag to Client table (default true)

ALTER TABLE "Client" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

-- Allow efficient filtering in client pickers and admin list
CREATE INDEX "Client_active_idx" ON "Client"("active");
