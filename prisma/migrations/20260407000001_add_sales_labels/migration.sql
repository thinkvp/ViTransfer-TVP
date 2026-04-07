-- CreateTable: SalesLabel
CREATE TABLE "SalesLabel" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "color" VARCHAR(7),
    "accountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesLabel_name_key" ON "SalesLabel"("name");

-- CreateIndex
CREATE INDEX "SalesLabel_sortOrder_idx" ON "SalesLabel"("sortOrder");

-- CreateIndex
CREATE INDEX "SalesLabel_isActive_idx" ON "SalesLabel"("isActive");

-- AlterTable: add labelId to SalesItem
ALTER TABLE "SalesItem" ADD COLUMN "labelId" TEXT;

-- CreateIndex
CREATE INDEX "SalesItem_labelId_idx" ON "SalesItem"("labelId");

-- AddForeignKey: SalesLabel -> Account (optional)
ALTER TABLE "SalesLabel" ADD CONSTRAINT "SalesLabel_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: SalesItem -> SalesLabel (optional)
ALTER TABLE "SalesItem" ADD CONSTRAINT "SalesItem_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "SalesLabel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
