-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "quickbooksCustomerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Client_quickbooksCustomerId_key" ON "Client"("quickbooksCustomerId");

-- CreateIndex
CREATE INDEX "Client_quickbooksCustomerId_idx" ON "Client"("quickbooksCustomerId");
