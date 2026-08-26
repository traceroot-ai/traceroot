-- AlterTable
-- The default is the reading every existing rule already gets, so no backfill:
-- a gap decides nothing, neither paging nor clearing, and an outstanding
-- page stays open while the severity reads NO_DATA.
ALTER TABLE "alerts" ADD COLUMN     "no_data_mode" VARCHAR NOT NULL DEFAULT 'HOLD';
