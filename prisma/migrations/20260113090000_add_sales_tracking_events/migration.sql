-- CreateTable
CREATE TABLE "SalesDocumentViewEvent" (
    "id" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "type" "SalesDocShareType" NOT NULL,
    "docId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDocumentViewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesDocumentViewEvent_shareToken_createdAt_idx" ON "SalesDocumentViewEvent"("shareToken", "createdAt");

-- CreateIndex
CREATE INDEX "SalesDocumentViewEvent_type_docId_createdAt_idx" ON "SalesDocumentViewEvent"("type", "docId", "createdAt");

-- AddForeignKey
ALTER TABLE "SalesDocumentViewEvent" ADD CONSTRAINT "SalesDocumentViewEvent_shareToken_fkey" FOREIGN KEY ("shareToken") REFERENCES "SalesDocumentShare"("token") ON DELETE CASCADE ON UPDATE CASCADE;
