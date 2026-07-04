-- CreateEnum
CREATE TYPE "ScheduleTaskKind" AS ENUM ('BAR', 'MILESTONE');

-- CreateEnum
CREATE TYPE "ScheduleTaskOwner" AS ENUM ('STUDIO', 'CLIENT');

-- CreateTable
CREATE TABLE "ProjectSchedule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT,
    "includeWeekends" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSchedulePhase" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSchedulePhase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectScheduleTask" (
    "id" TEXT NOT NULL,
    "phaseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "ScheduleTaskKind" NOT NULL DEFAULT 'BAR',
    "owner" "ScheduleTaskOwner" NOT NULL DEFAULT 'STUDIO',
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "showDeadline" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectScheduleTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSchedule_projectId_key" ON "ProjectSchedule"("projectId");

-- CreateIndex
CREATE INDEX "ProjectSchedulePhase_scheduleId_sortOrder_idx" ON "ProjectSchedulePhase"("scheduleId", "sortOrder");

-- CreateIndex
CREATE INDEX "ProjectScheduleTask_phaseId_sortOrder_idx" ON "ProjectScheduleTask"("phaseId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ProjectSchedule" ADD CONSTRAINT "ProjectSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSchedulePhase" ADD CONSTRAINT "ProjectSchedulePhase_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ProjectSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScheduleTask" ADD CONSTRAINT "ProjectScheduleTask_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "ProjectSchedulePhase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

