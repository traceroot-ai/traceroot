-- The "off" alert window has been removed: every detector alert is now a
-- windowed digest. Repoint the column default to the new default window and
-- migrate any existing rows still on the old "off" default to it.
ALTER TABLE "detector_alert_configs" ALTER COLUMN "alert_window" SET DEFAULT '10m';
UPDATE "detector_alert_configs" SET "alert_window" = '10m' WHERE "alert_window" = 'off';
