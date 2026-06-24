-- Project-level alert batching window for detector findings.
-- Default 'off' preserves the existing immediate per-finding alert behavior
-- for every existing project; no row rewrite needed.
ALTER TABLE "detector_alert_configs" ADD COLUMN "alert_window" VARCHAR NOT NULL DEFAULT 'off';
