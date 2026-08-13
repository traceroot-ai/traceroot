-- AlterTable
-- The default is the reading every existing rule already gets, so no backfill:
-- a gap decides nothing and leaves the rule on its last judgement.
ALTER TABLE "alerts" ADD COLUMN     "no_data_mode" VARCHAR NOT NULL DEFAULT 'HOLD';
