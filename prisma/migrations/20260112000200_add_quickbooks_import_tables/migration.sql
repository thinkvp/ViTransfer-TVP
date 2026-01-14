-- CreateTable
CREATE TABLE "QuickBooksEstimateImport" (
    "id" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "docNumber" TEXT,
    "txnDate" TIMESTAMP(3),
    "totalAmt" DECIMAL(18,2),
    "customerQboId" TEXT,
    "customerName" TEXT,
    "privateNote" TEXT,
    "lastUpdatedTime" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksEstimateImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksInvoiceImport" (
    "id" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "docNumber" TEXT,
    "txnDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "totalAmt" DECIMAL(18,2),
    "balance" DECIMAL(18,2),
    "customerQboId" TEXT,
    "customerName" TEXT,
    "privateNote" TEXT,
    "lastUpdatedTime" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksInvoiceImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksEstimateImport_qboId_key" ON "QuickBooksEstimateImport"("qboId");
CREATE INDEX "QuickBooksEstimateImport_lastUpdatedTime_idx" ON "QuickBooksEstimateImport"("lastUpdatedTime");
CREATE INDEX "QuickBooksEstimateImport_customerQboId_idx" ON "QuickBooksEstimateImport"("customerQboId");
CREATE INDEX "QuickBooksEstimateImport_docNumber_idx" ON "QuickBooksEstimateImport"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksInvoiceImport_qboId_key" ON "QuickBooksInvoiceImport"("qboId");
CREATE INDEX "QuickBooksInvoiceImport_lastUpdatedTime_idx" ON "QuickBooksInvoiceImport"("lastUpdatedTime");
CREATE INDEX "QuickBooksInvoiceImport_customerQboId_idx" ON "QuickBooksInvoiceImport"("customerQboId");
CREATE INDEX "QuickBooksInvoiceImport_docNumber_idx" ON "QuickBooksInvoiceImport"("docNumber");
