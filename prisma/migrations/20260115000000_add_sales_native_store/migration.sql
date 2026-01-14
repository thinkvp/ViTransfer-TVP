-- Persist native Sales docs (previously browser-localStorage only)

CREATE TABLE IF NOT EXISTS "SalesNativeStore" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SalesNativeStore_pkey" PRIMARY KEY ("id")
);
