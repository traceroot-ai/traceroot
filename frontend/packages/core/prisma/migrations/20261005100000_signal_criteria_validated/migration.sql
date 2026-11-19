-- Whether a new signal's criteria passed the check at creation. Diagnostic only:
-- a failed check still creates the signal. Null for rows from before the column,
-- category signals, and criteria edited by hand since.
ALTER TABLE "signals" ADD COLUMN "criteria_validated" BOOLEAN;
