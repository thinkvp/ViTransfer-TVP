-- AddTable: AccountingSettings
CREATE TABLE "AccountingSettings" (
    "id" TEXT NOT NULL,
    "reportingBasis" TEXT NOT NULL DEFAULT 'ACCRUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AccountingSettings" ("id", "reportingBasis", "createdAt", "updatedAt")
VALUES ('default', 'ACCRUAL', NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- AddColumns: SalesSettings
ALTER TABLE "SalesSettings"
  ADD COLUMN "dashboardReportingBasis" TEXT NOT NULL DEFAULT 'ACCRUAL',
  ADD COLUMN "dashboardAmountsIncludeGst" BOOLEAN NOT NULL DEFAULT true;