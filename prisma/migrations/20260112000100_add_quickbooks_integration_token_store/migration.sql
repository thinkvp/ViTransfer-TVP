-- CreateTable
CREATE TABLE "QuickBooksIntegration" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "refreshTokenEncrypted" TEXT,
    "lastRefreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksIntegration_pkey" PRIMARY KEY ("id")
);
