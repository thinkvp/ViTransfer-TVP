-- CreateTable
CREATE TABLE "QuickBooksPaymentImport" (
    "id" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "txnDate" TIMESTAMP(3),
    "totalAmt" DECIMAL(18,2),
    "customerQboId" TEXT,
    "customerName" TEXT,
    "paymentRefNum" TEXT,
    "privateNote" TEXT,
    "lastUpdatedTime" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksPaymentImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksPaymentAppliedInvoice" (
    "id" TEXT NOT NULL,
    "paymentImportId" TEXT NOT NULL,
    "invoiceQboId" TEXT NOT NULL,
    "invoiceImportId" TEXT,
    "amount" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickBooksPaymentAppliedInvoice_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "QuickBooksPaymentAppliedInvoice" ADD CONSTRAINT "QuickBooksPaymentAppliedInvoice_paymentImportId_fkey"
    FOREIGN KEY ("paymentImportId") REFERENCES "QuickBooksPaymentImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksPaymentAppliedInvoice" ADD CONSTRAINT "QuickBooksPaymentAppliedInvoice_invoiceImportId_fkey"
    FOREIGN KEY ("invoiceImportId") REFERENCES "QuickBooksInvoiceImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksPaymentImport_qboId_key" ON "QuickBooksPaymentImport"("qboId");
CREATE INDEX "QuickBooksPaymentImport_lastUpdatedTime_idx" ON "QuickBooksPaymentImport"("lastUpdatedTime");
CREATE INDEX "QuickBooksPaymentImport_customerQboId_idx" ON "QuickBooksPaymentImport"("customerQboId");
CREATE INDEX "QuickBooksPaymentImport_paymentRefNum_idx" ON "QuickBooksPaymentImport"("paymentRefNum");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksPaymentAppliedInvoice_paymentImportId_invoiceQboId_key" ON "QuickBooksPaymentAppliedInvoice"("paymentImportId", "invoiceQboId");
CREATE INDEX "QuickBooksPaymentAppliedInvoice_invoiceQboId_idx" ON "QuickBooksPaymentAppliedInvoice"("invoiceQboId");
CREATE INDEX "QuickBooksPaymentAppliedInvoice_invoiceImportId_idx" ON "QuickBooksPaymentAppliedInvoice"("invoiceImportId");
