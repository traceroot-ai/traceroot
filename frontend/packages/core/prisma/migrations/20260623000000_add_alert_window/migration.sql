-- Project-level alert batching window for detector findings. Every detector
-- alert is a windowed digest; new projects default to the 10m window.
ALTER TABLE "detector_alert_configs" ADD COLUMN "alert_window" VARCHAR NOT NULL DEFAULT '10m';
