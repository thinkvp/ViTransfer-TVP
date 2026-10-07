-- Prior-period adjustments for lodged BAS periods: records how each change found after
-- lodgement was resolved (carried into a later BAS, or amended with the ATO).
CREATE TYPE "BasAdjustmentResolution" AS ENUM ('CARRIED', 'AMENDED');

ALTER TABLE "BasPeriod" ADD COLUMN "excludedAdjustmentKeys" JSONB;

CREATE TABLE "BasAdjustment" (
    "id" TEXT NOT NULL,
    "sourcePeriodId" TEXT NOT NULL,
    "targetPeriodId" TEXT,
    "resolution" "BasAdjustmentResolution" NOT NULL,
    "recordKey" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "recordDate" TEXT NOT NULL,
    "g1Cents" INTEGER NOT NULL DEFAULT 0,
    "g3Cents" INTEGER NOT NULL DEFAULT 0,
    "g4Cents" INTEGER NOT NULL DEFAULT 0,
    "g10Cents" INTEGER NOT NULL DEFAULT 0,
    "g11Cents" INTEGER NOT NULL DEFAULT 0,
    "label1ACents" INTEGER NOT NULL DEFAULT 0,
    "label1BCents" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdByName" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BasAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BasAdjustment_sourcePeriodId_idx" ON "BasAdjustment"("sourcePeriodId");
CREATE INDEX "BasAdjustment_targetPeriodId_idx" ON "BasAdjustment"("targetPeriodId");

ALTER TABLE "BasAdjustment" ADD CONSTRAINT "BasAdjustment_sourcePeriodId_fkey" FOREIGN KEY ("sourcePeriodId") REFERENCES "BasPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BasAdjustment" ADD CONSTRAINT "BasAdjustment_targetPeriodId_fkey" FOREIGN KEY ("targetPeriodId") REFERENCES "BasPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
