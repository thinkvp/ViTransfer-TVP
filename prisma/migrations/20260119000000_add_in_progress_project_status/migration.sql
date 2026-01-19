-- Add new value to ProjectStatus enum
--
-- Note: Postgres enums can only append new values.
-- We use IF NOT EXISTS to make re-runs (or partial application) safer.
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
