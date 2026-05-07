-- CreateEnum
CREATE TYPE "VehicleLogbookStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "VehicleTripType" AS ENUM ('BUSINESS', 'PRIVATE');

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "make" VARCHAR(100) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "year" INTEGER,
    "engineCapacityCc" INTEGER,
    "registrationNumber" VARCHAR(30) NOT NULL,
    "colour" VARCHAR(60),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleLogbook" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "odometerStart" INTEGER NOT NULL,
    "odometerEnd" INTEGER,
    "status" "VehicleLogbookStatus" NOT NULL DEFAULT 'ACTIVE',
    "businessUsePercentOverride" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleLogbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleTrip" (
    "id" TEXT NOT NULL,
    "logbookId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "tripType" "VehicleTripType" NOT NULL,
    "purpose" VARCHAR(500) NOT NULL,
    "odometerStart" INTEGER,
    "odometerEnd" INTEGER,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleYearlyOdometer" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "financialYear" VARCHAR(20) NOT NULL,
    "odometerStart" INTEGER NOT NULL,
    "odometerEnd" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleYearlyOdometer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vehicle_isActive_idx" ON "Vehicle"("isActive");

-- CreateIndex
CREATE INDEX "VehicleLogbook_vehicleId_idx" ON "VehicleLogbook"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleLogbook_status_idx" ON "VehicleLogbook"("status");

-- CreateIndex
CREATE INDEX "VehicleLogbook_startDate_idx" ON "VehicleLogbook"("startDate");

-- CreateIndex
CREATE INDEX "VehicleTrip_logbookId_idx" ON "VehicleTrip"("logbookId");

-- CreateIndex
CREATE INDEX "VehicleTrip_date_idx" ON "VehicleTrip"("date");

-- CreateIndex
CREATE INDEX "VehicleTrip_tripType_idx" ON "VehicleTrip"("tripType");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleYearlyOdometer_vehicleId_financialYear_key" ON "VehicleYearlyOdometer"("vehicleId", "financialYear");

-- CreateIndex
CREATE INDEX "VehicleYearlyOdometer_vehicleId_idx" ON "VehicleYearlyOdometer"("vehicleId");

-- AddForeignKey
ALTER TABLE "VehicleLogbook" ADD CONSTRAINT "VehicleLogbook_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTrip" ADD CONSTRAINT "VehicleTrip_logbookId_fkey" FOREIGN KEY ("logbookId") REFERENCES "VehicleLogbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleYearlyOdometer" ADD CONSTRAINT "VehicleYearlyOdometer_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
