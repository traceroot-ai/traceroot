-- Keep detection time for signal lifecycle and notification ordering; use trace
-- start time for the shared Signals / Tracing window. Legacy rows remain unknown
-- until scripts/backfill_signal_trace_times.py is run against retained traces.
ALTER TABLE signal_hits ADD COLUMN trace_start_time TIMESTAMP(6);
CREATE INDEX ix_signal_hit_signal_trace_start ON signal_hits (signal_id, trace_start_time);
