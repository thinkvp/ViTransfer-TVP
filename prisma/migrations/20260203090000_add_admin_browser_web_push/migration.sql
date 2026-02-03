-- Add browser Web Push support (admin-only)

-- AlterTable Settings
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "webPushVapidPublicKey" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "webPushVapidPrivateKeyEncrypted" TEXT;

-- AddTable WebPushSubscription
CREATE TABLE IF NOT EXISTS "WebPushSubscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "deviceName" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WebPushSubscription" ADD COLUMN IF NOT EXISTS "deviceName" TEXT;
ALTER TABLE "WebPushSubscription" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");
CREATE INDEX IF NOT EXISTS "WebPushSubscription_userId_idx" ON "WebPushSubscription"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebPushSubscription_userId_fkey'
  ) THEN
    ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
