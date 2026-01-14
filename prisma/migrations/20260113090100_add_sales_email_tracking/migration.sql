-- CreateTable
CREATE TABLE "SalesEmailTracking" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "type" "SalesDocShareType" NOT NULL,
    "docId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),

    CONSTRAINT "SalesEmailTracking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesEmailTracking_token_key" ON "SalesEmailTracking"("token");

-- CreateIndex
CREATE INDEX "SalesEmailTracking_type_docId_sentAt_idx" ON "SalesEmailTracking"("type", "docId", "sentAt");

-- CreateIndex
CREATE INDEX "SalesEmailTracking_token_idx" ON "SalesEmailTracking"("token");

-- CreateIndex
CREATE INDEX "SalesEmailTracking_recipientEmail_idx" ON "SalesEmailTracking"("recipientEmail");

-- AddForeignKey
ALTER TABLE "SalesEmailTracking" ADD CONSTRAINT "SalesEmailTracking_shareToken_fkey" FOREIGN KEY ("shareToken") REFERENCES "SalesDocumentShare"("token") ON DELETE CASCADE ON UPDATE CASCADE;
