-- Add new values to ProjectStatus enum
--
-- Note: Postgres enums can only append new values.
-- We use IF NOT EXISTS to make re-runs (or partial application) safer.
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'NOT_STARTED';
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
