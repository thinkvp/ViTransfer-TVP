-- CreateTable
CREATE TABLE "SalesPreset" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesPresetItem" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "taxRatePercent" DOUBLE PRECISION NOT NULL,
    "taxRateName" VARCHAR(200),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesPresetItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesPreset_name_key" ON "SalesPreset"("name");

-- CreateIndex
CREATE INDEX "SalesPreset_name_idx" ON "SalesPreset"("name");

-- CreateIndex
CREATE INDEX "SalesPresetItem_presetId_idx" ON "SalesPresetItem"("presetId");

-- AddForeignKey
ALTER TABLE "SalesPresetItem" ADD CONSTRAINT "SalesPresetItem_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "SalesPreset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
