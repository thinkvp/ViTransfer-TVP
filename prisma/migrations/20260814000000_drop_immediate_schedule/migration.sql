-- Comment notifications are now always batched: the schedule options are HOURLY, DAILY and
-- NONE. Approvals and revision requests are unaffected — they bypass the schedule entirely.
--
-- Any row still holding 'IMMEDIATE' has to be moved to a real cadence: the batch workers
-- skip anything that isn't a batch schedule, so leaving it would silently stop those
-- projects (and the admin summary) from ever emailing again.

UPDATE "Project"
  SET "clientNotificationSchedule" = 'HOURLY'
  WHERE "clientNotificationSchedule" = 'IMMEDIATE';

UPDATE "Settings"
  SET "adminNotificationSchedule" = 'HOURLY'
  WHERE "adminNotificationSchedule" = 'IMMEDIATE';

UPDATE "Settings"
  SET "defaultClientNotificationSchedule" = 'HOURLY'
  WHERE "defaultClientNotificationSchedule" = 'IMMEDIATE';
